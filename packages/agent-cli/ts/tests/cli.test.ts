import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireChatWriteLock } from '@steerable/agent-shell/storage/process-locks';
import type { AgentClient } from '@steerable/agent-client';
import type { SSEEvent } from '@steerable/agent-protocol';
import { createCli } from '../src/cli.js';
import { decisionFor } from '../src/approve.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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

function client(overrides: Partial<AgentClient> = {}): AgentClient {
  return {
    lastStatus: 200,
    request: async () => ({ status: 200, data: { chatId: 'chat-1', chats: [] } }),
    stream: async function* () {
      yield { type: 'content', content: 'hello' } as SSEEvent;
      yield { type: 'done' } as SSEEvent;
    },
    events: async function* () {},
    decideApproval: async () => true,
    answerAsk: async () => true,
    close: async () => {},
    ...overrides,
  };
}

describe('createCli', () => {
  it('prints examples for --help', async () => {
    const stdout = capture();
    const code = await createCli({
      argv: ['--help'],
      stdout: stdout.stream,
      stderr: capture().stream,
      createClient: async () => client(),
    });
    expect(code).toBe(0);
    expect(stdout.text()).toContain('<product> run "列出当前目录"');
    expect(stdout.text()).toContain('<product> doctor');
  });

  it('rejects an unknown command', async () => {
    const stderr = capture();
    const code = await createCli({
      argv: ['nope'],
      stdout: capture().stream,
      stderr: stderr.stream,
      createClient: async () => client(),
    });
    expect(code).toBe(2);
    expect(stderr.text()).toContain('unknown command');
  });

  it('writes stream-json lines for a finished turn', async () => {
    const stdout = capture();
    const code = await createCli({
      argv: ['run', 'say hello', '--stream-json', '--data-dir', tempDir()],
      stdout: stdout.stream,
      stderr: capture().stream,
      createClient: async () => client(),
    });
    expect(code).toBe(0);
    const lines = stdout.text().trim().split('\n').map((line) => JSON.parse(line) as SSEEvent);
    expect(lines.map((line) => line.type)).toEqual(['content', 'done']);
  });

  it('exits 3 when the default policy denies a tool', async () => {
    const kinds: string[] = [];
    let release: (kind: string) => void = () => {};
    const decided = new Promise<string>((resolve) => {
      release = resolve;
    });
    const stdout = capture();
    const code = await createCli({
      argv: ['run', 'delete it', '--data-dir', tempDir()],
      stdout: stdout.stream,
      stderr: capture().stream,
      createClient: async () => client({
        events: async function* () {
          yield {
            channel: 'approval:request',
            payload: { requestId: 'req-1', toolName: 'local_exec_shell', category: 'local' },
          };
        },
        decideApproval: async (_id, kind) => {
          kinds.push(kind);
          release(kind);
          return true;
        },
        stream: async function* () {
          await decided;
          yield { type: 'content', content: 'denied' } as SSEEvent;
          yield { type: 'done' } as SSEEvent;
        },
      }),
    });
    expect(kinds).toEqual(['deny_once']);
    expect(code).toBe(3);
  });

  it('exits 6 when the chat is busy', async () => {
    const stderr = capture();
    const code = await createCli({
      argv: ['run', '--chat', 'chat-1', 'again', '--data-dir', tempDir()],
      stdout: capture().stream,
      stderr: stderr.stream,
      createClient: async () => client({
        lastStatus: 409,
        stream: async function* () {
          yield { type: 'error', code: 'chat_busy', message: '该会话正在另一个进程中运行' } as SSEEvent;
        },
      }),
    });
    expect(code).toBe(6);
    expect(stderr.text()).toContain('另一个进程');
  });

  it('warns and allows every tool for allow-all', async () => {
    const stderr = capture();
    const kinds: string[] = [];
    const code = await createCli({
      argv: ['run', 'go', '--approve', 'allow-all', '--data-dir', tempDir()],
      stdout: capture().stream,
      stderr: stderr.stream,
      createClient: async () => client({
        events: async function* () {
          yield {
            channel: 'approval:request',
            payload: { requestId: 'req-2', toolName: 'local_exec_shell', category: 'local' },
          };
        },
        decideApproval: async (_id, kind) => {
          kinds.push(kind);
          return true;
        },
      }),
    });
    expect(code).toBe(0);
    expect(kinds).toEqual(['allow_once']);
    expect(stderr.text()).toContain('--approve allow-all');
  });

  it('lists chats from the client', async () => {
    const stdout = capture();
    const code = await createCli({
      argv: ['chat', 'list', '--data-dir', tempDir()],
      stdout: stdout.stream,
      stderr: capture().stream,
      createClient: async () => client({
        request: async () => ({ status: 200, data: { chats: [{ id: 'chat-9', title: 'Notes' }] } }),
      }),
    });
    expect(code).toBe(0);
    expect(stdout.text()).toContain('chat-9');
    expect(stdout.text()).toContain('Notes');
  });

  it('keeps host logs off the terminal while a command writes to stdout', async () => {
    const info = console.info;
    const error = console.error;
    const seen: Array<{ info: boolean; error: boolean }> = [];
    const code = await createCli({
      argv: ['probe', '--data-dir', tempDir()],
      stdout: process.stdout,
      stderr: capture().stream,
      env: {},
      createClient: async () => client(),
      commands: [{
        name: 'probe',
        summary: 'records console state',
        run: () => {
          seen.push({ info: console.info === info, error: console.error === error });
          return 0;
        },
      }],
    });
    expect(code).toBe(0);
    expect(seen).toEqual([{ info: false, error: true }]);
    expect(console.info).toBe(info);
    expect(console.error).toBe(error);
  });

  it('reports a busy chat from the data directory', async () => {
    const dir = tempDir();
    const lease = acquireChatWriteLock(dir, 'chat-busy');
    try {
      const stdout = capture();
      const code = await createCli({
        argv: ['doctor', '--data-dir', dir],
        stdout: stdout.stream,
        stderr: capture().stream,
        createClient: async () => client(),
      });
      expect(code).toBe(0);
      expect(stdout.text()).toContain(`data dir: ${dir}`);
      expect(stdout.text()).toContain(`log file: ${path.join(dir, 'logs', 'main.log')}`);
      expect(stdout.text()).toContain('chat-busy');
      expect(stdout.text()).toContain('missing: run_code');
    } finally {
      lease.release();
    }
  });
});

describe('decisionFor', () => {
  it('allows a read tool only under allow-read', () => {
    expect(decisionFor('allow-read', { toolName: 'local_read_file', category: 'local' })).toBe('allow_once');
    expect(decisionFor('allow-read', { toolName: 'local_exec_shell', category: 'local' })).toBe('deny_once');
    expect(decisionFor('deny', { toolName: 'local_read_file' })).toBe('deny_once');
  });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-'));
  dirs.push(dir);
  return dir;
}
