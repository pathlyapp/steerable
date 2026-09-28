/**
 * 桌面宿主与命令行共用一个数据目录：命令行新建的会话在 2 秒内出现在
 * 桌面宿主的会话列表里；桌面宿主占着该会话时，命令行退出 6，终端只读。
 */
import { spawn, type ChildProcess } from 'node:child_process';
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
});

function startDesktop(dataDir: string): {
  ready: Promise<void>;
  mark: () => number;
  sawChat: (chatId: string, mark: number, ms: number) => Promise<void>;
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
