/**
 * 桌面宿主与命令行共用一个数据目录：命令行新建的会话在 2 秒内出现在
 * 桌面宿主的会话列表里；桌面宿主占着该会话时，命令行退出 6，终端只读。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createLocalClient } from '@steerable/agent-client';

import { createCli } from '../src/cli.js';
import { visibleText } from '../src/tui/screen.js';
import { AgentTui } from '../src/tui/session.js';

const shellDist = path.resolve(import.meta.dirname, '../../../agent-shell/ts/dist');
const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('desktop host beside the command line', () => {
  it('shows a new chat within 2s and keeps a busy chat read-only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-desktop-'));
    dirs.push(dir);
    const previousData = process.env.DEEPPATH_USER_DATA_DIR;
    const previousDocs = process.env.STEERABLE_DOCUMENTS_DIR;
    process.env.DEEPPATH_USER_DATA_DIR = dir;
    process.env.STEERABLE_DOCUMENTS_DIR = dir;
    const desktop = startDesktop(dir);
    try {
    await desktop.ready;

    const cli = await createLocalClient({ dataDir: dir, startSidecar: false });
    const before = desktop.mark();
    const created = await cli.request('POST', '/api/v2/chats/new', {});
    expect(created.status).toBe(200);
    const chatId = (created.data as { chatId: string }).chatId;
    await desktop.sawChat(chatId, before, 2_000);
    await cli.close();

    await desktop.hold(chatId);
    const stderr = capture();
    const code = await createCli({
      argv: ['chat', 'rm', chatId, '--data-dir', dir],
      stdout: capture().stream,
      stderr: stderr.stream,
      createClient: (options) => createLocalClient({ ...options, startSidecar: false }),
    });
    expect(code).toBe(6);
    expect(stderr.text()).toContain('另一个进程');

    const reader = await createLocalClient({ dataDir: dir, startSidecar: false });
    const session = new AgentTui(reader, { product: 'Demo', dataDir: dir, onExit() {} });
    await session.open();
    await typeLine(session, 'hello');
    const screen = visibleText(session.render(72));
    expect(screen).toContain('只读');
    expect(screen).not.toContain('user hello');
    await reader.close();
    } finally {
      desktop.stop();
      await desktop.exited;
      if (previousData === undefined) delete process.env.DEEPPATH_USER_DATA_DIR;
      else process.env.DEEPPATH_USER_DATA_DIR = previousData;
      if (previousDocs === undefined) delete process.env.STEERABLE_DOCUMENTS_DIR;
      else process.env.STEERABLE_DOCUMENTS_DIR = previousDocs;
    }
  }, 20_000);

  it('approves a read tool beside the desktop host, then a denied tool exits 3', async () => {
    const home = fs.mkdtempSync(path.join('/tmp', 'agent-cli-turn-'));
    dirs.push(home);
    const dir = path.join(home, 'data');
    fs.mkdirSync(dir);
    const restore = useIsolatedHome(home, dir);
    const desktop = startDesktop(dir);
    const mock = await startMockLlm();
    try {
      await desktop.ready;
      const preparer = await createLocalClient({ dataDir: dir, startSidecar: false });
      const saved = await preparer.request('POST', '/api/v2/local-settings/llm', {
        provider: 'openai-compat',
        model: 'e2e-mock',
        baseUrl: mock.baseUrl,
        apiKey: 'e2e-not-a-real-key',
        temperature: 0,
        systemPrompt: 'E2E 测试系统提示词。',
      });
      if (saved.status !== 200) {
        throw new Error(`llm settings ${saved.status} ${JSON.stringify(saved.data)}`);
      }
      await preparer.close();
      let armed = 0;
      const stdout = capture();
      const stderr = capture();
      const running = createCli({
        argv: ['run', '列出当前目录', '--approve', 'allow-read', '--stream-json', '--data-dir', dir],
        stdout: stdout.stream,
        stderr: stderr.stream,
        createClient: async (options) => {
          const client = await createLocalClient({ ...options, startSidecar: true });
          armed = Date.now();
          return client;
        },
      });
      const chatId = await desktop.waitForChat(() => armed, 20_000);
      expect(Date.now() - armed).toBeLessThan(2_000);
      const code = await running;
      expect(code, `${stderr.text()}\n${stdout.text()}`).toBe(0);
      const events = stdout.text().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type?: string; content?: string });
      expect(events.some((event) => event.type === 'content' && event.content?.includes('目录是空的'))).toBe(true);
      expect(stdout.text()).toContain('local_list_scripts');

      const denied = capture();
      const deniedErr = capture();
      const deniedCode = await createCli({
        argv: ['run', '删除构建目录', '--data-dir', dir, '--timeout', '20s'],
        stdout: denied.stream,
        stderr: deniedErr.stream,
        createClient: async (options) => createLocalClient({ ...options, startSidecar: true }),
      });
      expect(deniedCode, deniedErr.text()).toBe(3);

      await desktop.hold(chatId);
      const busyErr = capture();
      const busyCode = await createCli({
        argv: ['run', '继续', '--chat', chatId, '--data-dir', dir],
        stdout: capture().stream,
        stderr: busyErr.stream,
        createClient: (options) => createLocalClient({ ...options, startSidecar: false }),
      });
      expect(busyCode, busyErr.text()).toBe(6);
      expect(busyErr.text()).toContain('另一个进程');
    } finally {
      await mock.close();
      desktop.stop();
      await desktop.exited;
      restore();
    }
  }, 45_000);

  it('runs eight commands at the same time', async () => {
    const cli = path.resolve(import.meta.dirname, '../dist/cli.js');
    expect(fs.existsSync(cli), 'agent-cli dist is required').toBe(true);
    const home = fs.mkdtempSync(path.join('/tmp', 'agent-cli-eight-'));
    dirs.push(home);
    const dir = path.join(home, 'data');
    fs.mkdirSync(dir);
    const restore = useIsolatedHome(home, dir);
    const mock = await startMockLlm();
    const runs: Array<ReturnType<typeof spawnRun>> = [];
    try {
      const preparer = await createLocalClient({ dataDir: dir, startSidecar: false });
      const saved = await preparer.request('POST', '/api/v2/local-settings/llm', {
        provider: 'openai-compat',
        model: 'e2e-mock',
        baseUrl: mock.baseUrl,
        apiKey: 'e2e-not-a-real-key',
        temperature: 0,
        systemPrompt: 'E2E 测试系统提示词。',
      });
      expect(saved.status).toBe(200);
      await preparer.close();
      const script = writeRunScript(dir, cli);
      for (let slot = 0; slot < 8; slot += 1) runs.push(spawnRun(script, dir, `slot-${slot} 列出当前目录`));
      const results = await Promise.all(runs.map((run) => run.done));
      expect(results.map((result) => result.code)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      for (let slot = 0; slot < 8; slot += 1) {
        expect(results[slot].stdout, results[slot].stderr).toContain(`slot-${slot} 完成`);
      }
    } finally {
      for (const run of runs) run.stop();
      await mock.close();
      restore();
    }
  }, 60_000);
});

function startDesktop(dataDir: string): {
  ready: Promise<void>;
  mark: () => number;
  sawChat: (chatId: string, mark: number, ms: number) => Promise<void>;
  waitForChat: (armed: () => number, ms: number) => Promise<string>;
  hold: (chatId: string) => Promise<void>;
  exited: Promise<void>;
  stop: () => void;
} {
  const runtime = path.join(shellDist, 'host/runtime.js');
  const locks = path.join(shellDist, 'storage/process-locks.js');
  const script = path.join(dataDir, 'desktop-host.mjs');
  fs.writeFileSync(script, `
import { createHostRuntime } from ${JSON.stringify(pathToFileURL(runtime).href)};
import { acquireChatWriteLock } from ${JSON.stringify(pathToFileURL(locks).href)};
process.env.DEEPPATH_USER_DATA_DIR = process.argv[2];
process.env.STEERABLE_DOCUMENTS_DIR = process.argv[2];
const runtime = await createHostRuntime({
  broadcast(channel) {
    if (channel === 'store:changed') process.stdout.write('HOST changed\\n');
  },
  hasWindow: () => true,
  onLog() {},
  taskSweepReason: 'desktop test sweep',
});
let lease = null;
const keep = setInterval(() => {}, 60_000);
process.stdout.write('HOST ready\\n');
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    void command(line);
  }
});
async function command(line) {
  try {
    if (line === 'chats') {
      const res = await runtime.localBackendRouter.handle({ method: 'GET', path: '/api/v2/chats' });
      const chats = Array.isArray(res.data?.chats) ? res.data.chats.map((chat) => chat.id) : [];
      process.stdout.write('HOST chats ' + JSON.stringify(chats) + '\\n');
    } else if (line.startsWith('hold ')) {
      lease = acquireChatWriteLock(process.argv[2], line.slice(5));
      process.stdout.write('HOST held\\n');
    } else if (line === 'quit') {
      clearInterval(keep);
      lease?.release();
      await runtime.shutdown();
      process.exit(0);
    }
  } catch (error) {
    process.stdout.write('HOST error ' + (error instanceof Error ? error.message : String(error)) + '\\n');
  }
}
process.on('SIGTERM', () => {
  clearInterval(keep);
  process.exit(0);
});
`);
  const child = spawn(process.execPath, [script, dataDir], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DEEPPATH_USER_DATA_DIR: dataDir,
      STEERABLE_DOCUMENTS_DIR: dataDir,
    },
  });
  children.push(child);
  let output = '';
  let errors = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    errors += chunk;
  });
  const ready = waitFor(child, () => output.includes('HOST ready\n'), () => output + errors, 8_000);
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  return {
    ready,
    mark: () => output.length,
    async sawChat(chatId: string, mark: number, ms: number) {
      const started = Date.now();
      let last: string[] = [];
      while (Date.now() - started < ms) {
        const cursor = output.length;
        child.stdin?.write('chats\n');
        const remaining = Math.max(200, ms - (Date.now() - started));
        await waitFor(
          child,
          () => output.slice(cursor).includes('HOST chats '),
          () => output + errors,
          remaining,
        );
        const line = output.slice(cursor).split('\n').find((item) => item.startsWith('HOST chats '));
        last = JSON.parse(line?.slice('HOST chats '.length) || '[]') as string[];
        if (last.includes(chatId) && output.slice(mark).includes('HOST changed\n')) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`desktop missed ${chatId} within ${ms}ms: ${JSON.stringify(last)}\n${output}\n${errors}`);
    },
    async waitForChat(armed: () => number, ms: number) {
      const started = Date.now();
      let last: string[] = [];
      while (Date.now() - started < ms) {
        const cursor = output.length;
        child.stdin?.write('chats\n');
        await waitFor(
          child,
          () => output.slice(cursor).includes('HOST chats '),
          () => output + errors,
          Math.max(200, ms - (Date.now() - started)),
        );
        const line = output.slice(cursor).split('\n').find((item) => item.startsWith('HOST chats '));
        last = JSON.parse(line?.slice('HOST chats '.length) || '[]') as string[];
        const since = armed();
        if (since > 0 && last.length > 0 && output.includes('HOST changed\n')) return last[0];
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`desktop saw no chat within ${ms}ms: ${JSON.stringify(last)}\n${output}\n${errors}`);
    },
    async hold(chatId: string) {
      const mark = output.length;
      child.stdin?.write(`hold ${chatId}\n`);
      await waitFor(child, () => output.slice(mark).includes('HOST held\n'), () => output + errors, 5_000);
    },
    exited,
    stop() {
      if (child.exitCode === null) child.stdin?.write('quit\n');
    },
  };
}

function waitFor(
  child: ChildProcess,
  done: () => boolean,
  detail: () => string,
  timeoutMs: number,
): Promise<void> {
  if (done()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms: ${detail()}`));
    }, timeoutMs);
    const onData = () => {
      if (!done()) return;
      cleanup();
      resolve();
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`desktop exited ${code}: ${detail()}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', onExit);
  });
}

function capture(): { stream: Writable; text: () => string } {
  let body = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      body += String(chunk);
      callback();
    },
  });
  return { stream, text: () => body };
}

async function typeLine(session: AgentTui, text: string): Promise<void> {
  for (const char of text) session.handleInput(char);
  session.handleInput('\r');
  await session.settled();
}

const PROXY_KEYS = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const;

function useIsolatedHome(home: string, dataDir: string): () => void {
  const keys = ['HOME', 'USERPROFILE', 'DEEPPATH_USER_DATA_DIR', 'STEERABLE_DOCUMENTS_DIR', 'NO_PROXY', 'no_proxy', ...PROXY_KEYS];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.DEEPPATH_USER_DATA_DIR = dataDir;
  process.env.STEERABLE_DOCUMENTS_DIR = dataDir;
  process.env.NO_PROXY = '127.0.0.1,localhost,::1';
  process.env.no_proxy = '127.0.0.1,localhost,::1';
  for (const key of PROXY_KEYS) delete process.env[key];
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function writeRunScript(dataDir: string, cli: string): string {
  const script = path.join(dataDir, 'run-once.mjs');
  fs.writeFileSync(script, `
import { createCli } from ${JSON.stringify(pathToFileURL(cli).href)};
const code = await createCli({
  argv: ['run', process.argv[2], '--approve', 'allow-read', '--data-dir', process.argv[3]],
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);
`);
  return script;
}

function spawnRun(script: string, dataDir: string, task: string): {
  done: Promise<{ code: number; stdout: string; stderr: string }>;
  stop: () => void;
} {
  const child = spawn(process.execPath, [script, task, dataDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
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
  const done = new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`run timed out: ${task}\n${stdout}\n${stderr}`));
    }, 45_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
  return {
    done,
    stop() {
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

function startMockLlm(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const rounds = new Map<string, number>();
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
      if (wire.includes('标题生成助手') || wire.includes('对话追问建议助手')) {
        writeReply(res, parsed.stream === true, { kind: 'text', content: '会话' });
        return;
      }
      if (parsed.stream !== true) {
        writeReply(res, false, { kind: 'text', content: '{"route":"allow_no_tool","reason":"e2e"}' });
        return;
      }
      const slot = /slot-(\d+)/.exec(wire)?.[1];
      const task = slot ? `slot-${slot}` : wire.includes('删除构建目录') ? 'deny' : 'allow';
      const round = (rounds.get(task) ?? 0) + 1;
      rounds.set(task, round);
      if (round > 1) {
        const content = slot ? `slot-${slot} 完成` : task === 'allow' ? '目录是空的。' : '已拒绝。';
        writeReply(res, true, { kind: 'text', content });
        return;
      }
      writeReply(res, true, { kind: 'tool', name: 'local_list_scripts', args: {} });
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

function writeReply(
  res: ServerResponse,
  stream: boolean,
  reply: { kind: 'text'; content: string } | { kind: 'tool'; name: string; args: Record<string, unknown> },
): void {
  if (!stream) {
    const content = reply.kind === 'text' ? reply.content : '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-e2e',
      object: 'chat.completion',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  if (reply.kind === 'text') {
    send({ choices: [{ index: 0, delta: { content: reply.content } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  } else {
    send({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id: 'call_e2e_1', type: 'function', function: { name: reply.name, arguments: '' } }],
        },
      }],
    });
    send({
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.args) } }] },
      }],
    });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}
