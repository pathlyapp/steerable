import type { AgentClient } from '@steerable/agent-client';
import type { SSEEvent } from '@steerable/agent-protocol';

import { runTui } from './run.js';

const queue: Array<{ channel: string; payload: unknown }> = [];
const waiters: Array<(item: { channel: string; payload: unknown } | null) => void> = [];
let closed = false;
let decided: () => void = () => {};

function push(item: { channel: string; payload: unknown } | null): void {
  const waiter = waiters.shift();
  if (waiter) waiter(item);
  else if (item) queue.push(item);
}

const client: AgentClient = {
  lastStatus: 200,
  request: async (method, requestPath) => {
    if (method === 'GET' && requestPath === '/api/v2/chats') return { status: 200, data: { chats: [] } };
    if (method === 'GET' && requestPath === '/api/v2/local-settings/llm') return { status: 200, data: { model: 'demo-model' } };
    if (method === 'POST' && requestPath === '/api/v2/chats/new') return { status: 200, data: { chatId: 'chat-1' } };
    return { status: 200, data: {} };
  },
  async *stream(_requestPath, body, signal) {
    const message = String((body as { message?: string }).message ?? '');
    if (message.includes('hang')) {
      yield { type: 'content', content: 'running' } as SSEEvent;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      yield { type: 'error', message: 'interrupted' } as SSEEvent;
      return;
    }
    yield { type: 'tool_call', payload: { name: 'local_exec_shell', arguments: { command: 'ls' } } } as SSEEvent;
    const approval = new Promise<void>((resolve) => {
      decided = resolve;
    });
    push({
      channel: 'approval:request',
      payload: { requestId: 'req-1', toolName: 'local_exec_shell', arguments: { command: 'ls' } },
    });
    await approval;
    yield { type: 'tool_result', payload: { name: 'local_exec_shell' } } as SSEEvent;
    yield { type: 'content', content: 'listed' } as SSEEvent;
  },
  async *events() {
    while (!closed) {
      const queued = queue.shift();
      if (queued) {
        yield queued;
        continue;
      }
      const next = await new Promise<{ channel: string; payload: unknown } | null>((resolve) => waiters.push(resolve));
      if (!next) return;
      yield next;
    }
  },
  decideApproval: async () => {
    decided();
    return true;
  },
  answerAsk: async () => true,
  close: async () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter(null);
  },
};

await runTui({ client, product: 'Demo' });
await client.close();
process.exit(0);
