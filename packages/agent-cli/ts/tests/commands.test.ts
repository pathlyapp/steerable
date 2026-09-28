import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireChatWriteLock } from '@steerable/agent-shell/storage/process-locks';
import { createLocalClient, type AgentClient } from '@steerable/agent-client';
import { createCli } from '../src/cli.js';

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

function client(request: AgentClient['request']): AgentClient {
  return {
    lastStatus: 200,
    request,
    stream: async function* () {},
    events: async function* () {},
    decideApproval: async () => true,
    answerAsk: async () => true,
    close: async () => {},
  };
}

async function run(argv: string[], request: AgentClient['request']) {
  const stdout = capture();
  const stderr = capture();
  const dir = tempDir();
  const end = argv.indexOf('--');
  const args = end === -1
    ? [...argv, '--data-dir', dir]
    : [...argv.slice(0, end), '--data-dir', dir, ...argv.slice(end)];
  const code = await createCli({
    argv: args,
    stdout: stdout.stream,
    stderr: stderr.stream,
    createClient: async () => client(request),
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe('chat commands', () => {
  it('shows a chat and its messages', async () => {
    const result = await run(['chat', 'show', 'chat-1'], async (_method, requestPath) => {
      if (requestPath.endsWith('/messages')) {
        return {
          status: 200,
          data: {
            messages: [
              { role: 'user', content: 'hello' },
              { role: 'assistant', content: 'hi' },
            ],
          },
        };
      }
      return { status: 200, data: { id: 'chat-1', title: 'Notes' } };
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatchInlineSnapshot(`
      "chat-1	Notes
      user	hello
      assistant	hi
      "
    `);
  });

  it('exports a chat as markdown', async () => {
    const result = await run(['chat', 'export', 'chat-1', '--format', 'md'], async (_method, requestPath) => {
      if (requestPath.endsWith('/messages')) {
        return {
          status: 200,
          data: { messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }] },
        };
      }
      return { status: 200, data: { id: 'chat-1', title: 'Notes' } };
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatchInlineSnapshot(`
      "# Notes

      ## user

      hello

      ## assistant

      hi
      "
    `);
  });

  it('exits 6 when removing a busy chat', async () => {
    const result = await run(['chat', 'rm', 'chat-1'], async () => ({
      status: 409,
      data: { code: 'chat_busy', message: '该会话正在另一个进程中运行' },
    }));
    expect(result.code).toBe(6);
    expect(result.stderr).toContain('另一个进程');
  });

  it('exits 2 when show has no id', async () => {
    const result = await run(['chat', 'show'], async () => ({ status: 200, data: {} }));
    expect(result.code).toBe(2);
  });
});

describe('skills, mcp, and config', () => {
  it('lists skills', async () => {
    const result = await run(['skills', 'list'], async () => ({
      status: 200,
      data: { skills: [{ name: 'notes', origin: 'user', description: 'take notes' }] },
    }));
    expect(result.code).toBe(0);
    expect(result.stdout).toMatchInlineSnapshot(`
      "notes	user	take notes
      "
    `);
  });

  it('lists mcp servers', async () => {
    const result = await run(['mcp', 'list'], async () => ({
      status: 200,
      data: { servers: [{ name: 'files', command: 'node', args: ['server.js'] }] },
    }));
    expect(result.code).toBe(0);
    expect(result.stdout).toMatchInlineSnapshot(`
      "files	node server.js
      "
    `);
  });

  it('adds an mcp server from the command after --', async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const result = await run(['mcp', 'add', 'files', '--', 'node', 'server.js'], async (method, requestPath, body) => {
      calls.push({ method, path: requestPath, body });
      return { status: 200, data: { server: { name: 'files' } } };
    });
    expect(result.code).toBe(0);
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/v2/mcp/servers',
        body: { name: 'files', transport: 'stdio', command: 'node', args: ['server.js'] },
      },
    ]);
  });

  it('removes an mcp server by name', async () => {
    const calls: string[] = [];
    const result = await run(['mcp', 'rm', 'files'], async (method, requestPath) => {
      calls.push(`${method} ${requestPath}`);
      if (method === 'GET') {
        return { status: 200, data: { servers: [{ id: 'srv-1', name: 'files' }] } };
      }
      return { status: 200, data: { success: true, deleted: true } };
    });
    expect(result.code).toBe(0);
    expect(calls).toEqual([
      'GET /api/v2/mcp/servers',
      'DELETE /api/v2/mcp/servers/srv-1',
    ]);
  });

  it('prints one config value', async () => {
    const result = await run(['config', 'get', 'model'], async () => ({
      status: 200,
      data: { provider: 'openai-compat', model: 'demo-model' },
    }));
    expect(result.code).toBe(0);
    expect(result.stdout).toMatchInlineSnapshot(`
      "model=demo-model
      "
    `);
  });

  it('writes one config value back with the rest of the settings', async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    const result = await run(['config', 'set', 'model', 'next-model'], async (method, _path, body) => {
      calls.push({ method, body });
      return { status: 200, data: { provider: 'openai-compat', model: 'demo-model' } };
    });
    expect(result.code).toBe(0);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[1]).toEqual({
      method: 'POST',
      body: { provider: 'openai-compat', model: 'next-model' },
    });
  });

  it('rejects an unknown config key', async () => {
    const result = await run(['config', 'get', 'nope'], async () => ({ status: 200, data: {} }));
    expect(result.code).toBe(2);
  });
});

describe('chat rm against a held lock', () => {
  it('exits 6 when the chat lock is held', async () => {
    const dir = tempDir();
    const opener = await createLocalClient({ dataDir: dir, startSidecar: false });
    const created = await opener.request('POST', '/api/v2/chats/new', {});
    const chatId = (created.data as { chatId: string }).chatId;
    await opener.close();
    const lease = acquireChatWriteLock(dir, chatId);
    try {
      const stderr = capture();
      const code = await createCli({
        argv: ['chat', 'rm', chatId, '--data-dir', dir],
        stdout: capture().stream,
        stderr: stderr.stream,
        createClient: (options) => createLocalClient(options),
      });
      expect(code).toBe(6);
      expect(stderr.text()).toContain('另一个进程');
    } finally {
      lease.release();
    }
  });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-cmd-'));
  dirs.push(dir);
  return dir;
}
