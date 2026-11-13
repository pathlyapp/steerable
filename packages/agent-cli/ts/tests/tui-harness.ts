import fs from 'node:fs/promises';
import path from 'node:path';

import type { AgentClient, ApprovalDecisionKind } from '@steerable/agent-client';
import type { SSEEvent } from '@steerable/agent-protocol';

import { visibleText } from '../src/tui/screen.js';
import { AgentTui, type AgentTuiOptions } from '../src/tui/session.js';
import { registerTuiArtifact } from './tui-artifacts.js';

export interface RequestRecord {
  method: string;
  path: string;
  body: unknown;
}

export interface ApprovalRecord {
  requestId: string;
  kind: ApprovalDecisionKind;
  reason?: string;
}

export interface AnswerRecord {
  requestId: string;
  answer: unknown;
}

export interface TestChat {
  id: string;
  title: string;
}

export interface TuiHarnessOptions {
  caseId: string;
  width?: number;
  chats?: TestChat[];
  model?: string;
  request?: (
    method: string,
    requestPath: string,
    body: unknown,
  ) => Promise<{ status: number; data: unknown }> | { status: number; data: unknown };
  stream?: (requestPath: string, body: unknown, signal: AbortSignal) => AsyncIterable<SSEEvent>;
  decideApproval?: (
    requestId: string,
    kind: ApprovalDecisionKind,
    reason?: string,
  ) => Promise<boolean>;
  answerAsk?: (requestId: string, answer: unknown) => Promise<boolean>;
  session?: Omit<AgentTuiOptions, 'product' | 'onExit' | 'onChange'>;
}

interface QueuedEvent {
  channel: string;
  payload: unknown;
}

interface EventQueue {
  push(event: QueuedEvent): void;
  close(): void;
  next(): Promise<QueuedEvent | null>;
}

export class TuiHarness {
  readonly requests: RequestRecord[] = [];
  readonly approvals: ApprovalRecord[] = [];
  readonly answers: AnswerRecord[] = [];
  readonly trace: string[] = [];
  readonly session: AgentTui;
  readonly client: AgentClient;

  private readonly caseId: string;
  private readonly width: number;
  private readonly events = createEventQueue();
  private exited = false;

  constructor(options: TuiHarnessOptions) {
    this.caseId = options.caseId;
    this.width = options.width ?? 100;
    const chats = options.chats ?? [];
    const model = options.model ?? 'demo-model';
    const request = options.request;
    const stream = options.stream ?? emptyStream;
    const decideApproval = options.decideApproval;
    const answerAsk = options.answerAsk;
    const events = this.events;
    this.client = {
      lastStatus: 200,
      request: async (method, requestPath, body) => {
        this.requests.push({ method, path: requestPath, body });
        this.trace.push(`request ${method} ${requestPath}`);
        if (request) return request(method, requestPath, body);
        return defaultResponse(method, requestPath, body, chats, model);
      },
      stream: (requestPath, body, signal) => {
        this.trace.push(`stream ${requestPath}`);
        return stream(requestPath, body, signal);
      },
      events: () => readEvents(events),
      decideApproval: async (requestId, kind, reason) => {
        this.approvals.push({ requestId, kind, ...(reason ? { reason } : {}) });
        this.trace.push(`approval ${requestId} ${kind}`);
        return decideApproval ? decideApproval(requestId, kind, reason) : true;
      },
      answerAsk: async (requestId, answer) => {
        this.answers.push({ requestId, answer });
        this.trace.push(`answer ${requestId}`);
        return answerAsk ? answerAsk(requestId, answer) : true;
      },
      close: async () => {
        this.events.close();
        this.trace.push('client close');
      },
    };
    this.session = new AgentTui(this.client, {
      product: 'Demo',
      ...options.session,
      onChange: () => {
        this.trace.push('screen changed');
      },
      onExit: () => {
        this.exited = true;
        this.trace.push('session exit');
      },
    });
    registerTuiArtifact(this.caseId, () => this.screen(), () => this.trace);
  }

  async open(): Promise<void> {
    this.trace.push('session open');
    await this.session.open();
  }

  input(sequence: string): void {
    this.trace.push(`input ${JSON.stringify(sequence)}`);
    this.session.handleInput(sequence);
  }

  type(text: string): void {
    for (const char of text) this.input(char);
  }

  submit(text: string): void {
    this.type(text);
    this.input('\r');
  }

  emit(channel: string, payload: unknown): void {
    this.trace.push(`event ${channel}`);
    this.events.push({ channel, payload });
  }

  screen(width = this.width): string {
    return visibleText(this.session.render(width)).replaceAll('\x1b_pi:c\x07', '');
  }

  snapshot(): ReturnType<AgentTui['snapshot']> {
    return this.session.snapshot();
  }

  hasExited(): boolean {
    return this.exited;
  }

  async waitForText(text: string, timeoutMs = 1_000): Promise<string> {
    return this.waitFor((screen) => screen.includes(text), `text ${JSON.stringify(text)}`, timeoutMs);
  }

  async waitFor(
    predicate: (screen: string) => boolean,
    expectation: string,
    timeoutMs = 1_000,
  ): Promise<string> {
    const started = Date.now();
    let screen = this.screen();
    while (!predicate(screen)) {
      if (Date.now() - started >= timeoutMs) {
        await this.writeFailureArtifacts(expectation, screen);
        throw new Error(`${this.caseId} timed out waiting for ${expectation}\n${screen}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      screen = this.screen();
    }
    return screen;
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async writeFailureArtifacts(expectation: string, screen: string): Promise<void> {
    const root = process.env.TUI_ARTIFACT_DIR
      ?? path.resolve(import.meta.dirname, '../test-results/tui');
    const dir = path.join(root, safeName(this.caseId));
    await fs.mkdir(dir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(dir, 'screen.txt'), `${screen}\n`),
      fs.writeFile(path.join(dir, 'trace.json'), `${JSON.stringify(this.trace, null, 2)}\n`),
      fs.writeFile(path.join(dir, 'environment.json'), `${JSON.stringify({
        caseId: this.caseId,
        expectation,
        platform: process.platform,
        node: process.version,
        term: process.env.TERM ?? null,
        lang: process.env.LANG ?? null,
        width: this.width,
      }, null, 2)}\n`),
    ]);
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function* emptyStream(): AsyncIterable<SSEEvent> {}

async function* readEvents(events: EventQueue): AsyncIterable<QueuedEvent> {
  while (true) {
    const event = await events.next();
    if (!event) return;
    yield event;
  }
}

function defaultResponse(
  method: string,
  requestPath: string,
  _body: unknown,
  chats: TestChat[],
  model: string,
): { status: number; data: unknown } {
  if (method === 'GET' && requestPath === '/api/v2/local-settings/llm') {
    return { status: 200, data: { model } };
  }
  if (method === 'GET' && requestPath === '/api/v2/chats') {
    return { status: 200, data: { chats } };
  }
  if (method === 'GET' && requestPath.endsWith('/messages')) {
    return { status: 200, data: { messages: [] } };
  }
  if (method === 'GET' && requestPath.endsWith('/goal')) {
    return { status: 200, data: { goal: null } };
  }
  if (method === 'GET' && requestPath.endsWith('/loops')) {
    return { status: 200, data: { loops: [] } };
  }
  const chat = chats.find((entry) => requestPath.endsWith(`/chats/${encodeURIComponent(entry.id)}`));
  if (method === 'GET' && chat) {
    return { status: 200, data: chat };
  }
  if (method === 'POST' && requestPath === '/api/v2/chats/new') {
    return { status: 200, data: { chatId: 'chat-new' } };
  }
  return { status: 200, data: {} };
}

function createEventQueue(): EventQueue {
  const items: QueuedEvent[] = [];
  const waiters: Array<(event: QueuedEvent | null) => void> = [];
  let closed = false;
  return {
    push(event) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter(event);
      else items.push(event);
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter(null);
    },
    next() {
      const item = items.shift();
      if (item) return Promise.resolve(item);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-');
}
