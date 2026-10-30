/**
 * Section 11 UI: in a tmux session, a bound project receives a file the turn writes.
 */
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createLocalClient } from '@steerable/agent-client';

import { TmuxDriver } from './tmux-driver.js';

const bin = path.resolve(import.meta.dirname, '../dist/bin.js');
const dirs: string[] = [];
let driver: TmuxDriver | null = null;

afterEach(() => {
  driver?.kill();
  driver = null;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!TmuxDriver.isAvailable())('project file in tmux', () => {
  it('writes hello.txt inside the bound repository', async () => {
    expect(fs.existsSync(bin)).toBe(true);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-tmux-'));
    dirs.push(root);
    const repo = path.join(root, 'repo');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(repo);
    fs.mkdirSync(dataDir);
    const mock = await startMockLlm();
    const session = new TmuxDriver({
      caseId: 'project-write-hello',
      cwd: repo,
      env: isolatedEnv(dataDir),
    });
    driver = session;
    try {
      await saveMockLlm(dataDir, mock.baseUrl);
      session.start(process.execPath, [
        bin,
        'tui',
        '--approve',
        'allow-all',
        '--project',
        repo,
        '--data-dir',
        dataDir,
      ]);
      await session.waitFor('审批已关闭', 20_000);
      session.send('write-hello', 'Enter');
      const hello = path.join(repo, 'hello.txt');
      const started = Date.now();
      while (!fs.existsSync(hello)) {
        if (Date.now() - started > 20_000) {
          throw new Error(`hello.txt was not created\n${session.capture()}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(fs.readFileSync(hello, 'utf8')).toBe('phase1-hello\n');
      await leaveTui(session);
    } catch (error) {
      await session.writeFailureArtifacts(error);
      throw error;
    } finally {
      await mock.close();
    }
  }, 45_000);

  it('accepts a bracketed paste and finishes without an approval row', async () => {
    expect(fs.existsSync(bin)).toBe(true);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-tmux-paste-'));
    dirs.push(root);
    const repo = path.join(root, 'repo');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(repo);
    fs.mkdirSync(dataDir);
    const mock = await startMockLlm();
    const session = new TmuxDriver({
      caseId: 'T-UNA-14',
      cwd: repo,
      env: isolatedEnv(dataDir),
    });
    driver = session;
    try {
      await saveMockLlm(dataDir, mock.baseUrl);
      session.start(process.execPath, [
        bin,
        'tui',
        '--approve',
        'allow-all',
        '--project',
        repo,
        '--data-dir',
        dataDir,
      ]);
      await session.waitFor('审批已关闭', 20_000);
      session.sendLiteral('\x1b[200~write-hello\x1b[201~');
      const drafted = await session.waitFor('write-hello', 10_000);
      expect(drafted).not.toContain('审批 local_');
      session.send('Enter');
      const hello = path.join(repo, 'hello.txt');
      const started = Date.now();
      while (!fs.existsSync(hello)) {
        if (Date.now() - started > 20_000) {
          throw new Error(`hello.txt was not created\n${session.capture()}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(fs.readFileSync(hello, 'utf8')).toBe('phase1-hello\n');
      const done = session.capture();
      expect(done).not.toContain('审批 local_');
      await leaveTui(session);
    } catch (error) {
      await session.writeFailureArtifacts(error);
      throw error;
    } finally {
      await mock.close();
    }
  }, 45_000);
});

/** Ctrl+C leaves. A turn that is still finishing takes the first press as an interrupt. */
async function leaveTui(session: TmuxDriver): Promise<void> {
  session.send('C-c');
  const started = Date.now();
  while (session.exists() && Date.now() - started < 10_000) {
    if (session.capture().includes('已中断')) {
      session.send('C-c');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await session.waitUntilGone(10_000);
}

function isolatedEnv(dataDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env, DEEPPATH_USER_DATA_DIR: dataDir };
  for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
    delete env[key];
  }
  env.NO_PROXY = '127.0.0.1,localhost,::1';
  env.no_proxy = env.NO_PROXY;
  return env;
}

async function saveMockLlm(dataDir: string, baseUrl: string): Promise<void> {
  const client = await createLocalClient({ dataDir, startSidecar: false });
  try {
    const saved = await client.request('POST', '/api/v2/local-settings/llm', {
      provider: 'openai-compat',
      model: 'e2e-mock',
      baseUrl,
      apiKey: 'e2e-not-a-real-key',
      temperature: 0,
      systemPrompt: 'E2E 测试系统提示词。',
    });
    if (saved.status !== 200) {
      throw new Error(`llm settings ${saved.status} ${JSON.stringify(saved.data)}`);
    }
  } finally {
    await client.close();
  }
}

function startMockLlm(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  let wrote = false;
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsed: { messages?: unknown; stream?: boolean } = {};
      try {
        parsed = JSON.parse(body) as { messages?: unknown; stream?: boolean };
      } catch {
        res.writeHead(400).end();
        return;
      }
      const wire = JSON.stringify(parsed.messages ?? []);
      if (!parsed.stream || wire.includes('标题生成助手') || wire.includes('对话追问建议助手')) {
        writeText(res, parsed.stream === true, wire.includes('标题') ? '会话' : '{"route":"allow_no_tool","reason":"e2e"}');
        return;
      }
      if (wire.includes('write-hello') && !wrote) {
        wrote = true;
        writeTool(res, 'local_write_file', { path: 'hello.txt', content: 'phase1-hello\n' });
        return;
      }
      writeText(res, true, '已写入');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function writeText(res: ServerResponse, stream: boolean, content: string): void {
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-e2e',
      object: 'chat.completion',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}

function writeTool(res: ServerResponse, name: string, args: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{ index: 0, id: 'call_e2e_1', type: 'function', function: { name, arguments: '' } }],
      },
    }],
  });
  send({
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] },
    }],
  });
  send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  res.end('data: [DONE]\n\n');
}
