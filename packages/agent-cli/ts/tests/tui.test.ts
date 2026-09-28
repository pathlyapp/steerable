import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentClient } from '@steerable/agent-client';
import type { SSEEvent } from '@steerable/agent-protocol';
import { getNativeClipboard } from '@earendil-works/pi-tui';
import { createCli } from '../src/cli.js';
import { installAgentKeybindings } from '../src/tui/keys.js';
import { renderScreen, visibleText } from '../src/tui/screen.js';
import { AgentTui } from '../src/tui/session.js';

afterEach(() => {
  installAgentKeybindings();
});

describe('tui screen', () => {
  it('renders a tool card, the seven approval decisions, and a read-only occupied chat', () => {
    const tool = visibleText(renderScreen({
      product: 'Demo',
      title: 'Notes',
      modelName: 'demo-model',
      lines: [
        { kind: 'user', text: '列出目录' },
        { kind: 'tool', name: 'local_exec_shell', args: 'ls -la', status: '✓ 0.3s' },
      ],
      approval: null,
      ask: null,
      chats: null,
      readOnly: false,
      help: false,
      draft: '',
      status: '',
    }, 72));
    expect(tool).toContain('Demo · Notes · demo-model');
    expect(tool).toContain('▸ local_exec_shell  ls -la  ✓ 0.3s');

    const approval = visibleText(renderScreen({
      product: 'Demo',
      title: 'Notes',
      modelName: 'demo-model',
      lines: [],
      approval: { toolName: 'local_exec_shell', summary: 'rm -rf build' },
      ask: null,
      chats: null,
      readOnly: false,
      help: false,
      draft: '',
      status: '',
    }, 72));
    expect(approval).toContain('审批 local_exec_shell rm -rf build');
    expect(approval).toContain('y 本次允许');
    expect(approval).toContain('s 本会话');
    expect(approval).toContain('a 总是');
    expect(approval).toContain('n 拒绝');
    expect(approval).toContain('N 本会话拒绝');
    expect(approval).toContain('A 总是拒绝');
    expect(approval).toContain('Esc 中止');

    const busy = visibleText(renderScreen({
      product: 'Demo',
      title: 'Build',
      modelName: 'demo-model',
      lines: [],
      approval: null,
      ask: null,
      chats: [
        { id: 'chat-1', title: 'Notes', busy: false, selected: false },
        { id: 'chat-2', title: 'Build', busy: true, selected: true },
      ],
      readOnly: true,
      help: false,
      draft: '',
      status: '',
    }, 72));
    expect(busy).toContain('chat-2  Build  只读');
    expect(busy).toContain('只读 · 另一个进程正在运行');
  });
});

describe('tui session', () => {
  it('answers an approval and aborts the next turn from the key table', async () => {
    const decisions: string[] = [];
    let releaseApproval: (kind: string) => void = () => {};
    const approvalDone = new Promise<string>((resolve) => {
      releaseApproval = resolve;
    });
    const events: Array<{ channel: string; payload: unknown }> = [];
    let pushEvent: (event: { channel: string; payload: unknown }) => void = () => {};
    const queued = new Promise<{ channel: string; payload: unknown }>((resolve) => {
      pushEvent = resolve;
    });
    const client = fakeClient({
      async *stream(_path, body, signal) {
        const message = String((body as { message?: string }).message ?? '');
        if (message.includes('hang')) {
          yield { type: 'content', content: 'running' } as SSEEvent;
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
          yield { type: 'error', message: 'interrupted' } as SSEEvent;
          return;
        }
        yield { type: 'tool_call', payload: { name: 'local_exec_shell', arguments: { command: 'ls' } } } as SSEEvent;
        pushEvent({
          channel: 'approval:request',
          payload: { requestId: 'req-1', toolName: 'local_exec_shell', arguments: { command: 'ls' } },
        });
        await approvalDone;
        yield { type: 'content', content: 'listed' } as SSEEvent;
      },
      async *events() {
        events.push(await queued);
        yield events[0];
      },
      async decideApproval(_id, kind) {
        decisions.push(kind);
        releaseApproval(kind);
        return true;
      },
    });
    const session = new AgentTui(client, { product: 'Demo', onExit() {} });
    await session.open();
    await typeLine(session, 'hello');
    await waitFor(() => visibleText(session.render(72)).includes('审批'));
    session.handleInput('y');
    await waitFor(() => visibleText(session.render(72)).includes('listed'));
    expect(decisions).toEqual(['allow_once']);
    expect(visibleText(session.render(72))).toContain('▸ local_exec_shell  ls');

    await typeLine(session, 'hang');
    await waitFor(() => visibleText(session.render(72)).includes('running'));
    session.handleInput('\x03');
    await waitFor(() => visibleText(session.render(72)).includes('已中断'));
  });

  it('uses a rebound interrupt key and leaves ctrl+c alone', async () => {
    installAgentKeybindings({ 'agent.interrupt': 'ctrl+x' });
    let exited = 0;
    const session = new AgentTui(fakeClient(), { product: 'Demo', onExit() { exited += 1; } });
    await session.open();
    session.handleInput('\x03');
    expect(exited).toBe(0);
    session.handleInput('\x18');
    expect(exited).toBe(1);
  });

  it('runs slash commands for a new chat, the model, clearing, and help', async () => {
    const calls: string[] = [];
    const session = new AgentTui(fakeClient({
      stream: async function* () {
        yield { type: 'content', content: 'old' } as SSEEvent;
      },
      request: async (method, requestPath, body) => {
        calls.push(`${method} ${requestPath}`);
        if (method === 'POST' && requestPath === '/api/v2/chats/new') {
          return { status: 200, data: { chatId: 'chat-new' } };
        }
        if (method === 'POST') return { status: 200, data: { ...(body as object), model: 'next-model' } };
        if (requestPath.endsWith('/messages')) return { status: 200, data: { messages: [] } };
        if (requestPath.startsWith('/api/v2/chats/')) return { status: 200, data: { id: 'chat-new', title: 'New' } };
        return { status: 200, data: { provider: 'openai-compat', model: 'demo-model', chats: [] } };
      },
    }), { product: 'Demo', onExit() {} });
    await session.open();
    await typeLine(session, 'hello');
    await waitFor(() => visibleText(session.render(72)).includes('old'));
    await typeLine(session, '/clear');
    expect(visibleText(session.render(72))).not.toContain('old');
    await typeLine(session, '/help');
    expect(visibleText(session.render(72))).toContain('/model');
    session.handleInput('\x1b');
    await typeLine(session, '/model next-model');
    expect(visibleText(session.render(72))).toContain('next-model');
    await typeLine(session, '/new');
    expect(calls).toContain('POST /api/v2/chats/new');
    expect(visibleText(session.render(72))).toContain('New');
  });

  it('opens a busy chat as read-only', async () => {
    const session = new AgentTui(fakeClient({
      request: async (method, requestPath) => {
        if (method === 'GET' && requestPath === '/api/v2/chats') {
          return { status: 200, data: { chats: [{ id: 'chat-2', title: 'Build' }] } };
        }
        if (requestPath.endsWith('/messages')) return { status: 200, data: { messages: [] } };
        if (requestPath.startsWith('/api/v2/chats/')) return { status: 200, data: { id: 'chat-2', title: 'Build' } };
        return { status: 200, data: { model: 'demo-model' } };
      },
    }), {
      product: 'Demo',
      busyChatIds: ['chat-2'],
      onExit() {},
    });
    await session.open();
    session.handleInput('\x0c');
    session.handleInput('\r');
    expect(visibleText(session.render(72))).toContain('只读 · 另一个进程正在运行');
    await typeLine(session, 'hello');
    expect(visibleText(session.render(72))).not.toContain('user hello');
  });
});

describe('tui command', () => {
  it('refuses to start when stdin is not a terminal', async () => {
    const stderr = capture();
    const code = await createCli({
      argv: ['tui'],
      stdout: capture().stream,
      stderr: stderr.stream,
      stdinIsTTY: false,
      createClient: async () => fakeClient(),
    });
    expect(code).toBe(2);
    expect(stderr.text()).toContain('run');
  });

  it('loads the clipboard helper without throwing when the native module is missing', () => {
    expect(() => getNativeClipboard()).not.toThrow();
  });
});

function fakeClient(overrides: Partial<AgentClient> = {}): AgentClient {
  return {
    lastStatus: 200,
    request: async () => ({ status: 200, data: { chats: [], model: 'demo-model' } }),
    stream: async function* () {},
    events: async function* () {},
    decideApproval: async () => true,
    answerAsk: async () => true,
    close: async () => {},
    ...overrides,
  };
}

async function typeLine(session: AgentTui, text: string): Promise<void> {
  for (const char of text) session.handleInput(char);
  session.handleInput('\r');
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function waitFor(check: () => boolean): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 1000) throw new Error('timed out waiting for the tui');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
