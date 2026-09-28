/**
 * 模拟用户：命令行完成一轮带工具的对话，拒绝下一轮；
 * 另一个进程占着会话时，命令行退出 6，终端里该会话只读。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { createLocalClient, listBusyChatIds, type AgentClient } from '@steerable/agent-client';
import type { SSEEvent } from '@steerable/agent-protocol';

import { createCli } from '../src/cli.js';
import { visibleText } from '../src/tui/screen.js';
import { AgentTui } from '../src/tui/session.js';

const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('simulated user', () => {
  it('approves one tool, then a denied approval exits 3', async () => {
    const kinds: string[] = [];
    const stdout = capture();
    const allowed = await createCli({
      argv: ['run', '列出当前目录', '--approve', 'allow-all', '--data-dir', tempDir()],
      stdout: stdout.stream,
      stderr: capture().stream,
      createClient: async () => scriptedClient(kinds, 'listed the directory'),
    });
    expect(allowed).toBe(0);
    expect(kinds).toEqual(['allow_once']);
    expect(stdout.text()).toContain('listed the directory');

    const deniedKinds: string[] = [];
    const denied = await createCli({
      argv: ['run', '删除构建目录', '--data-dir', tempDir()],
      stdout: capture().stream,
      stderr: capture().stream,
      createClient: async () => scriptedClient(deniedKinds, 'should not finish'),
    });
    expect(deniedKinds).toEqual(['deny_once']);
    expect(denied).toBe(3);
  });

  it('stays out of a chat another process is running', async () => {
    const dir = tempDir();
    const opener = await createLocalClient({ dataDir: dir, startSidecar: false });
    const created = await opener.request('POST', '/api/v2/chats/new', {});
    const chatId = (created.data as { chatId: string }).chatId;
    await opener.close();

    const holder = holdChat(dir, chatId);
    await holder.held;
    try {
      expect(listBusyChatIds(dir)).toContain(chatId);
      const stderr = capture();
      const code = await createCli({
        argv: ['chat', 'rm', chatId, '--data-dir', dir],
        stdout: capture().stream,
        stderr: stderr.stream,
        createClient: (options) => createLocalClient(options),
      });
      expect(code).toBe(6);
      expect(stderr.text()).toContain('另一个进程');

      const session = new AgentTui(scriptedClient([], '', {
        request: async (method, requestPath) => {
          if (method === 'GET' && requestPath === '/api/v2/chats') {
            return { status: 200, data: { chats: [{ id: chatId, title: 'Notes' }] } };
          }
          if (requestPath.endsWith('/messages')) return { status: 200, data: { messages: [] } };
          if (requestPath.includes('/chats/')) return { status: 200, data: { id: chatId, title: 'Notes' } };
          return { status: 200, data: { model: 'demo-model' } };
        },
        events: async function* () {},
      }), { product: 'Demo', dataDir: dir, onExit() {} });
      await session.open();
      session.handleInput('\x0c');
      session.handleInput('\r');
      await typeLine(session, 'hello');
      const screen = visibleText(session.render(72));
      expect(screen).toContain('只读');
      expect(screen).not.toContain('user hello');
    } finally {
      holder.stop();
      await holder.exited;
    }
  }, 15000);
});

function holdChat(dataDir: string, chatId: string): { held: Promise<void>; exited: Promise<void>; stop: () => void } {
  const locks = path.resolve(import.meta.dirname, '../../../agent-shell/ts/dist/storage/process-locks.js');
  const script = path.join(dataDir, 'hold-chat.mjs');
  fs.writeFileSync(script, `
import fs from 'node:fs';
import { acquireChatWriteLock } from ${JSON.stringify(pathToFileUrl(locks))};
const lease = acquireChatWriteLock(process.argv[2], process.argv[3]);
const keep = setInterval(() => {}, 60_000);
fs.writeSync(1, 'held\\n');
process.on('SIGTERM', () => {
  clearInterval(keep);
  lease.release();
  process.exit(0);
});
`);
  const child = spawn(process.execPath, [script, dataDir, chatId], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  const held = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`holder did not start: ${output}${errors}`)), 8000);
    const finish = () => {
      if (!output.includes('held')) return;
      clearTimeout(timer);
      child.stdout?.off('data', finish);
      resolve();
    };
    finish();
    child.stdout?.on('data', finish);
    child.once('exit', (code) => {
      if (output.includes('held')) return;
      clearTimeout(timer);
      reject(new Error(`holder exited ${code} before ready: ${output}${errors}`));
    });
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  return {
    held,
    exited,
    stop: () => {
      if (child.exitCode === null) child.kill('SIGTERM');
    },
  };
}

function pathToFileUrl(file: string): string {
  return new URL(`file://${file}`).href;
}

function scriptedClient(
  kinds: string[],
  answer: string,
  overrides: Partial<AgentClient> = {},
): AgentClient {
  let release: (kind: string) => void = () => {};
  const decided = new Promise<string>((resolve) => {
    release = resolve;
  });
  return {
    lastStatus: 200,
    request: async (method, requestPath) => {
      if (method === 'POST' && requestPath === '/api/v2/chats/new') {
        return { status: 200, data: { chatId: 'chat-1' } };
      }
      return { status: 200, data: {} };
    },
    stream: async function* () {
      yield {
        type: 'tool_call',
        payload: { name: 'local_exec_shell', arguments: { command: 'ls' } },
      } as SSEEvent;
      await decided;
      if (kinds.at(-1) === 'deny_once') return;
      yield { type: 'content', content: answer } as SSEEvent;
      yield { type: 'done' } as SSEEvent;
    },
    events: async function* () {
      yield {
        channel: 'approval:request',
        payload: { requestId: 'req-1', toolName: 'local_exec_shell', category: 'local', arguments: { command: 'ls' } },
      };
    },
    decideApproval: async (_id, kind) => {
      kinds.push(kind);
      release(kind);
      return true;
    },
    answerAsk: async () => true,
    close: async () => {},
    ...overrides,
  };
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-user-'));
  dirs.push(dir);
  return dir;
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
  await new Promise((resolve) => setTimeout(resolve, 20));
}
