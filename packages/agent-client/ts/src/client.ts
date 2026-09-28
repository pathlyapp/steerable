import fs from 'node:fs';
import path from 'node:path';
import type { SSEEvent } from '@steerable/agent-protocol';
import { createHostRuntime, type HostRuntime } from '@steerable/agent-shell/host/runtime';
import {
  acquireChatWriteLock,
  ChatBusyError,
} from '@steerable/agent-shell/storage/process-locks';
import type { ApprovalDecisionKind } from '@steerable/agent-shell/sidecar/reverse-approval';

import { applyHostRuntimeEnv } from './host-runtime-env.js';
import { createSseParser } from './sse.js';

export interface AgentClient {
  request(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }>;
  stream(path: string, body: unknown, signal: AbortSignal): AsyncIterable<SSEEvent>;
  events(): AsyncIterable<{ channel: string; payload: unknown }>;
  decideApproval(requestId: string, kind: ApprovalDecisionKind, reason?: string): Promise<boolean>;
  answerAsk(requestId: string, answer: unknown): Promise<boolean>;
  /** Status of the most recent `stream` call, after the iterator finishes. */
  lastStatus: number | null;
  close(): Promise<void>;
}

export interface LocalClientOptions {
  dataDir?: string;
  /** When false, the Python sidecar is not started. Chat and lock calls still work. */
  startSidecar?: boolean;
  hasWindow?: () => boolean;
  env?: NodeJS.ProcessEnv;
}

interface Queued<T> {
  items: T[];
  waiters: Array<(value: T | null) => void>;
  closed: boolean;
}

function queue<T>(): Queued<T> & {
  push: (item: T) => void;
  close: () => void;
  next: () => Promise<T | null>;
} {
  const state: Queued<T> = { items: [], waiters: [], closed: false };
  return {
    ...state,
    push(item) {
      if (state.closed) return;
      const waiter = state.waiters.shift();
      if (waiter) waiter(item);
      else state.items.push(item);
    },
    close() {
      state.closed = true;
      for (const waiter of state.waiters.splice(0)) waiter(null);
    },
    next() {
      const item = state.items.shift();
      if (item !== undefined) return Promise.resolve(item);
      if (state.closed) return Promise.resolve(null);
      return new Promise((resolve) => state.waiters.push(resolve));
    },
  };
}

/** Opens one in-process host and exposes it as the CLI/TUI client. */
export async function createLocalClient(options: LocalClientOptions = {}): Promise<AgentClient> {
  const env = options.env ?? process.env;
  if (options.dataDir) env.DEEPPATH_USER_DATA_DIR = options.dataDir;
  const dataDir = env.DEEPPATH_USER_DATA_DIR;
  if (dataDir) applyHostRuntimeEnv(dataDir, env);

  const events = queue<{ channel: string; payload: unknown }>();
  const runtime = await createHostRuntime({
    broadcast: (channel, payload) => events.push({ channel, payload }),
    hasWindow: options.hasWindow ?? (() => false),
    onLog: () => {},
    taskSweepReason: '命令行进程退出时中断了未完成的任务',
  });
  if (options.startSidecar !== false) await runtime.start();

  const client: AgentClient = {
    lastStatus: null,
    request: (method, requestPath, body) => request(runtime, method, requestPath, body),
    stream: (requestPath, body, signal) => stream(runtime, client, requestPath, body, signal),
    events: () => ({
      async *[Symbol.asyncIterator]() {
        while (true) {
          const item = await events.next();
          if (!item) return;
          yield item;
        }
      },
    }),
    async decideApproval(requestId, kind, reason) {
      return runtime.approvalBridge.decide({ requestId, kind, reason: reason ?? '' }).ok;
    },
    async answerAsk(requestId, answer) {
      const answers = answer && typeof answer === 'object' ? answer : {};
      return runtime.askUserBridge.answer({ requestId, answers }).ok;
    },
    async close() {
      events.close();
      await runtime.shutdown();
    },
  };
  return client;
}

async function request(
  runtime: HostRuntime,
  method: string,
  requestPath: string,
  body: unknown,
): Promise<{ status: number; data: unknown }> {
  const response = await runtime.localBackendRouter.handle({ method, path: requestPath, body });
  return { status: response.status, data: response.data };
}

async function* stream(
  runtime: HostRuntime,
  client: AgentClient,
  requestPath: string,
  body: unknown,
  signal: AbortSignal,
): AsyncIterable<SSEEvent> {
  const frames = queue<SSEEvent>();
  const parse = createSseParser((event) => frames.push(event));
  const pending = runtime.localBackendRouter.handleStream(
    { method: 'POST', path: requestPath, body },
    parse,
    { signal },
  ).then(
    (result) => {
      client.lastStatus = result.status;
      frames.close();
    },
    (error: unknown) => {
      client.lastStatus = 1;
      frames.push({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      frames.close();
    },
  );
  while (true) {
    const event = await frames.next();
    if (!event) break;
    yield event;
  }
  await pending;
}

/** Chat ids whose write lock is held by another process. */
export function listBusyChatIds(dataDir: string): string[] {
  const dir = path.join(dataDir, 'locks', 'chat');
  if (!fs.existsSync(dir)) return [];
  const busy: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.lock')) continue;
    const chatId = name.slice(0, -'.lock'.length);
    try {
      acquireChatWriteLock(dataDir, chatId).release();
    } catch (error) {
      if (error instanceof ChatBusyError) busy.push(chatId);
      else throw error;
    }
  }
  return busy.sort();
}
