/**
 * Section 11 integration: the agent-cli process, not an in-process call.
 * Home and a product with projects off exit before a turn. A temp directory,
 * a symlink, and a subdirectory share one project record.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createLocalClient } from '@steerable/agent-client';

const bin = path.resolve(import.meta.dirname, '../dist/bin.js');
const cli = path.resolve(import.meta.dirname, '../dist/cli.js');
const shellDist = path.resolve(import.meta.dirname, '../../../agent-shell/ts/dist');
const clientDist = path.resolve(import.meta.dirname, '../../../agent-client/ts/dist/index.js');
const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('agent-cli project binding subprocess', () => {
  it('exits 2 from the home directory before starting the host', async () => {
    expect(fs.existsSync(bin)).toBe(true);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-home-'));
    dirs.push(dataDir);
    const result = await spawnBin(
      ['run', 'hello', '--data-dir', dataDir],
      dataDir,
      os.homedir(),
    );
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('不会自动把家目录绑定为项目');
    expect(result.stderr).toContain('--no-project');
    expect(fs.existsSync(path.join(dataDir, 'agent-projects.json'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'agent-shell.db'))).toBe(false);
  });

  it('binds a directory, its symlink, and a subdirectory to one project', async () => {
    expect(fs.existsSync(bin)).toBe(true);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-bind-'));
    dirs.push(root);
    const repo = path.join(root, 'repo');
    const link = path.join(root, 'link');
    const nested = path.join(repo, 'src');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(repo);
    fs.mkdirSync(nested);
    fs.symlinkSync(repo, link, 'dir');
    fs.mkdirSync(dataDir);
    const mock = await startMockLlm();
    try {
      await saveMockLlm(dataDir, mock.baseUrl);
      const real = fs.realpathSync(repo);
      const first = await spawnBin(
        ['run', 'hello', '--approve', 'deny', '--project', repo, '--data-dir', dataDir],
        dataDir,
      );
      expect(first.code, first.stderr).toBe(0);
      expect(first.stderr).toContain(`已绑定项目 repo：${real}`);

      const linked = await spawnBin(
        ['run', 'hello', '--approve', 'deny', '--project', link, '--data-dir', dataDir],
        dataDir,
      );
      expect(linked.code, linked.stderr).toBe(0);
      expect(linked.stderr).not.toContain('已绑定项目');

      const childDir = await spawnBin(
        ['run', 'hello', '--approve', 'deny', '--project', nested, '--data-dir', dataDir],
        dataDir,
      );
      expect(childDir.code, childDir.stderr).toBe(0);
      expect(childDir.stderr).not.toContain('已绑定项目');

      const projects = readProjects(dataDir);
      expect(projects).toHaveLength(1);
      expect(projects[0]?.folderPath).toBe(real);
    } finally {
      await mock.close();
    }
  }, 120_000);

  it('puts project rules in the system prompt only after --trust', async () => {
    expect(fs.existsSync(bin)).toBe(true);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-rules-'));
    dirs.push(root);
    const repo = path.join(root, 'repo');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(repo);
    fs.mkdirSync(dataDir);
    const marker = 'PHASE1-RULE-MARKER-9f3c';
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), `# rules\n${marker}\n`);
    const seen: string[] = [];
    const mock = await startMockLlm(seen);
    try {
      await saveMockLlm(dataDir, mock.baseUrl);
      const unbound = await spawnBin(
        ['run', 'hello', '--approve', 'deny', '--project', repo, '--data-dir', dataDir],
        dataDir,
      );
      expect(unbound.code, unbound.stderr).toBe(0);
      expect(unbound.stderr).toContain('有 1 个规则文件未加载（--trust 加载）');
      const before = seen.join('\n');
      expect(before).toContain('【项目模式】');
      expect(before).not.toContain('【项目规则】');
      expect(before).not.toContain(marker);

      seen.length = 0;
      const trusted = await spawnBin(
        ['run', 'hello', '--approve', 'deny', '--trust', '--project', repo, '--data-dir', dataDir],
        dataDir,
      );
      expect(trusted.code, trusted.stderr).toBe(0);
      expect(trusted.stderr).toContain('已加载 1 个规则文件：AGENTS.md');
      const after = seen.join('\n');
      expect(after).toContain('【项目规则】');
      expect(after).toContain(marker);
    } finally {
      await mock.close();
    }
  }, 90_000);

  it('binds one project when two runs start together', async () => {
    expect(fs.existsSync(bin)).toBe(true);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-race-'));
    dirs.push(root);
    const repo = path.join(root, 'repo');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(repo);
    fs.mkdirSync(dataDir);
    const mock = await startMockLlm();
    try {
      await saveMockLlm(dataDir, mock.baseUrl);
      const args = ['run', 'hello', '--approve', 'deny', '--project', repo, '--data-dir', dataDir];
      const [left, right] = await Promise.all([
        spawnBin(args, dataDir),
        spawnBin(args, dataDir),
      ]);
      expect(left.code, left.stderr).toBe(0);
      expect(right.code, right.stderr).toBe(0);
      const bound = [left.stderr, right.stderr].filter((text) => text.includes('已绑定项目'));
      expect(bound).toHaveLength(1);
      expect(bound[0]).toContain(fs.realpathSync(repo));
      expect(readProjects(dataDir)).toHaveLength(1);
    } finally {
      await mock.close();
    }
  }, 60_000);

  it('exits 2 when the product has projects disabled', async () => {
    expect(fs.existsSync(cli)).toBe(true);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-off-'));
    dirs.push(root);
    const repo = path.join(root, 'repo');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(repo);
    fs.mkdirSync(dataDir);
    const script = path.join(root, 'run-off.mjs');
    fs.writeFileSync(script, `
import { setProductConfig } from ${JSON.stringify(pathToFileURL(path.join(shellDist, 'product-config.js')).href)};
import { createLocalClient } from ${JSON.stringify(pathToFileURL(clientDist).href)};
import { createCli } from ${JSON.stringify(pathToFileURL(cli).href)};
setProductConfig({ hostTools: { projects: false } });
const code = await createCli({
  argv: ['run', 'hello', '--project', process.argv[2], '--data-dir', process.argv[3]],
  stdout: process.stdout,
  stderr: process.stderr,
  createClient: (options) => createLocalClient({ ...options, startSidecar: false }),
});
process.exit(code);
`);
    const result = await spawnNode([script, repo, dataDir], dataDir);
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('该产品未启用项目模式，请使用 --no-project。');
    const file = path.join(dataDir, 'agent-projects.json');
    if (fs.existsSync(file)) {
      expect(JSON.stringify(readProjects(dataDir))).not.toContain(fs.realpathSync(repo));
    }
  });
});

function spawnBin(args: string[], dataDir: string, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return spawnNode([bin, ...args], dataDir, cwd);
}

function spawnNode(
  argv: string[],
  dataDir: string,
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env, DEEPPATH_USER_DATA_DIR: dataDir };
  for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
    delete env[key];
  }
  env.NO_PROXY = '127.0.0.1,localhost,::1';
  env.no_proxy = env.NO_PROXY;
  const child = spawn(process.execPath, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli timed out\n${stdout}\n${stderr}`));
    }, 40_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
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

function readProjects(dataDir: string): Array<{ id: string; folderPath: string }> {
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-projects.json'), 'utf8')) as {
    projects?: Array<{ id: string; folderPath: string }>;
  };
  return raw.projects ?? [];
}

function startMockLlm(seen: string[] = []): Promise<{ baseUrl: string; close: () => Promise<void> }> {
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
      const system = systemText(parsed.messages);
      if (system) seen.push(system);
      if (!parsed.stream || wire.includes('标题生成助手') || wire.includes('对话追问建议助手')) {
        writeReply(res, parsed.stream === true, wire.includes('标题') ? '会话' : '{"route":"allow_no_tool","reason":"e2e"}');
        return;
      }
      writeReply(res, true, 'ok');
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

function systemText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  return messages
    .filter((message): message is { role?: string; content?: unknown } => Boolean(message) && typeof message === 'object')
    .filter((message) => message.role === 'system')
    .map((message) => messageText(message.content))
    .join('\n');
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && 'text' in part) return String((part as { text: unknown }).text);
    return '';
  }).join('\n');
}

function writeReply(res: ServerResponse, stream: boolean, content: string): void {
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
