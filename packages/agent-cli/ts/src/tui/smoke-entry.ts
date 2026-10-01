import type { AgentClient } from '@steerable/agent-client';
import type { SSEEvent } from '@steerable/agent-protocol';

import { createCli } from '../cli.js';
import { runTui } from './run.js';

const queue: Array<{ channel: string; payload: unknown }> = [];
const waiters: Array<(item: { channel: string; payload: unknown } | null) => void> = [];
let closed = false;
let decided: () => void = () => {};
let goal: { objective: string; phase: string; turns: number } | null = null;
let loops: Array<{ id: string; prompt: string; intervalSeconds: number }> = [];
const proactiveMessages: Array<Record<string, unknown>> = [];
let liveActive = false;

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
    if (method === 'GET' && requestPath.endsWith('/goal')) return { status: 200, data: { goal } };
    if (method === 'GET' && requestPath.endsWith('/loops')) return { status: 200, data: { loops } };
    if (method === 'DELETE' && requestPath.includes('/loops/')) {
      const id = requestPath.split('/').pop();
      loops = loops.filter((loop) => loop.id !== id);
      push({ channel: 'loop-changed', payload: { chatId: 'chat-1', loops } });
      return { status: 200, data: { success: true } };
    }
    if (method === 'GET' && requestPath.endsWith('/live-stream')) {
      return {
        status: 200,
        data: liveActive ? { active: true, content: 'goal wake running' } : { active: false },
      };
    }
    if (method === 'GET' && requestPath.endsWith('/messages')) {
      return {
        status: 200,
        data: {
          messages: proactiveMessages,
        },
      };
    }
    return { status: 200, data: {} };
  },
  async *stream(_requestPath, body, signal) {
    const message = String((body as { message?: string }).message ?? '');
    if (message.startsWith('/goal ')) {
      goal = { objective: message.slice('/goal '.length), phase: 'active', turns: 1 };
      push({ channel: 'goal-changed', payload: { chatId: 'chat-1', goal } });
      yield { type: 'content', content: 'goal accepted' } as SSEEvent;
      setTimeout(() => {
        liveActive = true;
        push({
          channel: 'chat-turn-started',
          payload: { chatId: 'chat-1', trigger: 'goal', sourceId: 'goal-1' },
        });
        setTimeout(() => {
          liveActive = false;
          proactiveMessages.push(
            {
              role: 'user',
              content: '<objective>hidden</objective>',
              messageMetadata: JSON.stringify({
                internal: true,
                trigger: 'goal',
                sourceId: 'goal-1',
              }),
            },
            { role: 'assistant', content: 'goal wake completed' },
          );
          goal = { ...goal!, turns: 2 };
          push({
            channel: 'chat-turn-finished',
            payload: { chatId: 'chat-1', trigger: 'goal', status: 'completed' },
          });
        }, 250);
      }, 100);
      return;
    }
    if (message.startsWith('/loop ')) {
      const finite = message.includes('until complete');
      const id = finite ? 'loop-finite' : 'loop-recurring';
      loops = [{
        id,
        prompt: finite ? 'monitor demo until complete' : 'recurring demo',
        intervalSeconds: 1,
      }];
      push({ channel: 'loop-changed', payload: { chatId: 'chat-1', loops } });
      yield { type: 'content', content: `loop armed ${id}` } as SSEEvent;
      if (finite) scheduleFiniteLoopWake(id, 1);
      return;
    }
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

function scheduleFiniteLoopWake(id: string, attempt: number): void {
  setTimeout(() => {
    liveActive = true;
    push({
      channel: 'chat-turn-started',
      payload: { chatId: 'chat-1', trigger: 'loop', sourceId: id },
    });
    setTimeout(() => {
      liveActive = false;
      proactiveMessages.push(
        {
          role: 'user',
          content: 'hidden loop wake',
          messageMetadata: JSON.stringify({
            internal: true,
            trigger: 'loop',
            sourceId: id,
          }),
        },
        {
          role: 'assistant',
          content: attempt === 1 ? 'loop monitoring pending' : 'loop reached terminal state',
        },
      );
      if (attempt === 2) {
        loops = [];
        push({ channel: 'loop-changed', payload: { chatId: 'chat-1', loops } });
      }
      push({
        channel: 'chat-turn-finished',
        payload: { chatId: 'chat-1', trigger: 'loop', sourceId: id, status: 'completed' },
      });
      if (attempt === 1) scheduleFiniteLoopWake(id, 2);
    }, 200);
  }, 150);
}

const defaultCli = process.argv.includes('--default-cli');
const code = defaultCli
  ? await createCli({
    argv: [],
    createClient: async () => client,
    installSignals: false,
  })
  : await runTui({ client, product: 'Demo' });
if (!defaultCli) await client.close();
process.exit(code);
