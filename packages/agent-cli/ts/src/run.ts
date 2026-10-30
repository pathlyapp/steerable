import type { AgentClient } from '@steerable/agent-client';
import type { SSEEvent } from '@steerable/agent-protocol';

import { autoAnswer, decisionFor, denied, type ApprovalSpec, type ApprovePolicy } from './approve.js';
import { cliText } from './copy.js';
import { ruleStatusLine, type RuleContext } from './rules.js';

export interface RunRequest {
  task: string;
  chatId?: string;
  agentId?: string;
  projectId?: string;
  files: string[];
  policy: ApprovePolicy;
  json: boolean;
  streamJson: boolean;
  timeoutMs?: number;
}

export async function runTurn(
  client: AgentClient,
  request: RunRequest,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  signal: AbortSignal,
): Promise<number> {
  if (request.policy === 'allow-all') {
    stderr.write(`${cliText('cli.approveAllWarning')}\n`);
  }
  let chatId = request.chatId;
  if (!chatId) {
    const created = await client.request('POST', '/api/v2/chats/new', {
      ...(request.agentId ? { agentId: request.agentId } : {}),
      ...(request.projectId ? { projectId: request.projectId } : {}),
    });
    if (created.status !== 200) {
      stderr.write(`failed to create chat (${created.status})\n`);
      return 1;
    }
    chatId = (created.data as { chatId?: string }).chatId;
    if (!chatId) {
      stderr.write('failed to create chat\n');
      return 1;
    }
  }
  await reportRules(client, chatId, stderr);

  let exitCode = 0;
  let deniedApproval = false;
  const text: string[] = [];
  const autoAnswered: AutoAnswered[] = [];
  const printedTools = new Set<string>();
  const streamOrder: StreamOrder = { heldTools: [], pendingAnswers: [] };
  const spec: ApprovalSpec = { policy: request.policy, answerAsk: request.policy === 'allow-all' };
  const approvals = watchApprovals(client, spec, request, stdout, stderr, autoAnswered, streamOrder, () => {
    deniedApproval = true;
  });
  try {
    for await (const event of client.stream(
      `/api/v2/chats/${encodeURIComponent(chatId)}/send`,
      { message: messageText(request), ...(request.agentId ? { agentId: request.agentId } : {}) },
      signal,
    )) {
      const next = observeEvent(event, request, stdout, stderr, text, streamOrder, printedTools);
      if (next !== 0) exitCode = next;
    }
  } finally {
    approvals.stop();
    if (request.streamJson) flushStreamOrder(streamOrder, stdout);
  }
  if (signal.aborted && exitCode === 0) exitCode = 1;
  if (deniedApproval) exitCode = 3;
  if (client.lastStatus === 409) exitCode = 6;
  if (request.json) {
    stdout.write(`${JSON.stringify({
      ok: exitCode === 0,
      chatId,
      ...(request.projectId ? { projectId: request.projectId } : {}),
      text: text.join(''),
      exitCode,
      autoAnswered,
    })}\n`);
  }
  return exitCode;
}

async function reportRules(
  client: AgentClient,
  chatId: string,
  stderr: NodeJS.WritableStream,
): Promise<void> {
  const response = await client.request('GET', `/api/v2/chats/${encodeURIComponent(chatId)}/project-context`, undefined);
  if (response.status !== 200) return;
  const line = ruleStatusLine(response.data as RuleContext, 'cli');
  if (line) stderr.write(`${line}\n`);
}

function messageText(request: RunRequest): string {
  const lines = [request.task];
  if (request.files.length > 0) {
    lines.push('Files:');
    for (const file of request.files) lines.push(`- ${file}`);
  }
  return lines.join('\n');
}

type AutoAnswered =
  | { kind: 'approval'; toolName: string; category: string; decision: string }
  | { kind: 'ask_user'; prompt: string };

interface HeldLine {
  name: string;
  id: string;
  line: string;
  kind?: 'call' | 'actions';
  names?: string[];
  prefix?: string[];
}

/** Tool lines wait here so `auto_answered` can be written immediately before them. */
interface StreamOrder {
  heldTools: HeldLine[];
  pendingAnswers: HeldLine[];
}

function answerName(record: AutoAnswered): string {
  return record.kind === 'ask_user' ? 'ask_user' : record.toolName;
}

function writeAnswerBeforeTool(
  order: StreamOrder,
  record: AutoAnswered,
  stdout: NodeJS.WritableStream,
  streamJson: boolean,
): void {
  if (!streamJson) return;
  const name = answerName(record);
  const line = JSON.stringify({ type: 'auto_answered', ...record });
  const index = order.heldTools.findIndex((tool) => tool.name === name || tool.names?.includes(name));
  if (index < 0) {
    order.pendingAnswers.push({ name, id: '', line });
    return;
  }
  const tool = order.heldTools[index];
  if (!tool) return;
  const waiting = (tool.names ?? [tool.name]).filter((item) => item !== name);
  tool.prefix = [...(tool.prefix ?? []), line];
  if (waiting.length > 0) {
    tool.names = waiting;
    tool.name = waiting[0] ?? '';
    return;
  }
  order.heldTools.splice(index, 1);
  for (const item of tool.prefix) stdout.write(`${item}\n`);
  stdout.write(`${tool.line}\n`);
}

function flushHeldActions(order: StreamOrder, stdout: NodeJS.WritableStream): void {
  const kept: HeldLine[] = [];
  for (const tool of order.heldTools) {
    if (tool.kind !== 'actions') {
      kept.push(tool);
      continue;
    }
    for (const item of tool.prefix ?? []) stdout.write(`${item}\n`);
    stdout.write(`${tool.line}\n`);
  }
  order.heldTools = kept;
}

function unsettledToolNames(event: SSEEvent): string[] {
  const actions = event.actions;
  if (!Array.isArray(actions)) return [];
  const names: string[] = [];
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    const row = action as ProgressAction;
    const settled = typeof row.durationMs === 'number' || typeof row.success === 'boolean' || row.error != null;
    if (settled) continue;
    names.push(typeof row.tool === 'string' && row.tool ? row.tool : 'tool');
  }
  return names;
}

function eventField(event: SSEEvent, key: string): string {
  const payload = event.payload;
  if (!payload || typeof payload !== 'object') return '';
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

function writeStreamJsonEvent(order: StreamOrder, event: SSEEvent, stdout: NodeJS.WritableStream): void {
  const line = JSON.stringify(event);
  const actions = String(event.type) === 'executed_actions';
  if (actions || event.type === 'content' || event.type === 'done') flushHeldActions(order, stdout);
  if (actions) {
    const names = unsettledToolNames(event);
    const matched: string[] = [];
    for (const name of names) {
      const index = order.pendingAnswers.findIndex((answer) => answer.name === name);
      if (index < 0) continue;
      const answer = order.pendingAnswers.splice(index, 1)[0];
      if (answer) matched.push(answer.line);
    }
    if (matched.length > 0 || names.length === 0) {
      for (const answer of matched) stdout.write(`${answer}\n`);
      stdout.write(`${line}\n`);
      return;
    }
    order.heldTools.push({
      name: names[0] ?? '',
      id: '',
      line,
      kind: 'actions',
      names,
    });
    return;
  }
  if (event.type === 'tool_call') {
    const name = eventField(event, 'name');
    const index = order.pendingAnswers.findIndex((answer) => answer.name === name);
    if (index >= 0) {
      const answer = order.pendingAnswers.splice(index, 1)[0];
      stdout.write(`${answer.line}\n${line}\n`);
      return;
    }
    order.heldTools.push({ name, id: eventField(event, 'id'), line, kind: 'call' });
    return;
  }
  if (event.type === 'tool_result') {
    const name = eventField(event, 'name');
    const id = eventField(event, 'id');
    const index = order.heldTools.findIndex((tool) => (id && tool.id === id) || (name && tool.name === name));
    if (index >= 0) {
      const tool = order.heldTools.splice(index, 1)[0];
      stdout.write(`${tool.line}\n`);
    }
  }
  stdout.write(`${line}\n`);
}

function writeHeld(tool: HeldLine, stdout: NodeJS.WritableStream, extra?: string): void {
  for (const item of tool.prefix ?? []) stdout.write(`${item}\n`);
  if (extra) stdout.write(`${extra}\n`);
  stdout.write(`${tool.line}\n`);
}

function flushStreamOrder(order: StreamOrder, stdout: NodeJS.WritableStream): void {
  const pending = order.pendingAnswers.splice(0);
  const held = order.heldTools.splice(0);
  const used = new Set<number>();
  for (const answer of pending) {
    const index = held.findIndex((tool, toolIndex) => {
      if (used.has(toolIndex)) return false;
      return tool.name === answer.name || (tool.names?.includes(answer.name) ?? false);
    });
    if (index < 0) {
      stdout.write(`${answer.line}\n`);
      continue;
    }
    used.add(index);
    const tool = held[index];
    if (tool) writeHeld(tool, stdout, answer.line);
  }
  held.forEach((tool, index) => {
    if (!used.has(index)) writeHeld(tool, stdout);
  });
}

function watchApprovals(
  client: AgentClient,
  spec: ApprovalSpec,
  request: RunRequest,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  autoAnswered: AutoAnswered[],
  streamOrder: StreamOrder,
  onDenied: () => void,
): { stop: () => void } {
  let stopped = false;
  const loop = (async () => {
    for await (const event of client.events()) {
      if (stopped) return;
      if (event.channel === 'approval:request') {
        const prompt = event.payload as {
          requestId?: string;
          toolName?: string;
          category?: string;
          mode?: string;
          arguments?: unknown;
        };
        if (!prompt.requestId) continue;
        const kind = decisionFor(spec, { mode: prompt.mode }, 'run');
        if (kind === 'prompt') continue;
        if (denied(kind)) onDenied();
        const record: AutoAnswered = {
          kind: 'approval',
          toolName: prompt.toolName ?? '',
          category: prompt.category ?? '',
          decision: kind,
        };
        autoAnswered.push(record);
        writeAnswerBeforeTool(streamOrder, record, stdout, request.streamJson);
        if (!request.json && !request.streamJson && record.toolName === 'network_egress' && kind === 'allow_once') {
          stderr.write(`${egressProgressLine(prompt.arguments)}\n`);
        }
        await client.decideApproval(prompt.requestId, kind);
      } else if (event.channel === 'ask-user:request') {
        const prompt = event.payload as { requestId?: string; prompt?: string; questions?: { id: string }[] };
        if (!prompt.requestId) continue;
        if (spec.answerAsk) {
          const questions = prompt.questions?.length ? prompt.questions : [{ id: 'answer' }];
          const record: AutoAnswered = { kind: 'ask_user', prompt: prompt.prompt ?? '' };
          autoAnswered.push(record);
          writeAnswerBeforeTool(streamOrder, record, stdout, request.streamJson);
          await client.answerAsk(prompt.requestId, { answers: autoAnswer(questions) });
        } else {
          await client.answerAsk(prompt.requestId, {});
        }
      }
    }
  })();
  void loop;
  return {
    stop() {
      stopped = true;
    },
  };
}

interface ProgressAction {
  id?: string;
  tool?: string;
  arguments?: unknown;
  view?: { title?: string };
  success?: boolean;
  error?: unknown;
  durationMs?: number;
  approval?: { kind?: string; cached?: boolean };
}

function formatRunDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function progressArgs(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of ['command', 'path', 'file', 'url', 'query']) {
    const field = record[key];
    if (typeof field === 'string' && field.length > 0) return field;
  }
  return '';
}

function egressTarget(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as { host?: unknown; port?: unknown };
  const host = typeof record.host === 'string' ? record.host : '';
  if (!host) return '';
  const port = typeof record.port === 'number' ? record.port : null;
  if (port === null || port === 80 || port === 443) return host;
  return `${host}:${port}`;
}

function egressProgressLine(args: unknown): string {
  const target = egressTarget(args);
  return `▸ network_egress  ${target}  ✓ ${cliText('tui.toolAuto')}`.trimEnd();
}

function toolProgressLine(action: ProgressAction): string {
  const name = typeof action.tool === 'string' && action.tool ? action.tool : 'tool';
  const title = typeof action.view?.title === 'string' ? action.view.title : '';
  const args = title && title !== name ? title : progressArgs(action.arguments);
  const failed = action.success === false || action.error != null;
  const duration = typeof action.durationMs === 'number' ? formatRunDuration(action.durationMs) : '';
  const mark = failed ? '✗' : '✓';
  const base = duration ? `${mark} ${duration}` : mark;
  const cached = action.approval?.kind === 'allow_for_session' && action.approval.cached === true;
  const status = cached ? `${base} 本会话已允许` : base;
  return `▸ ${name}  ${args}  ${status}`.trimEnd();
}

function writeToolProgress(event: SSEEvent, stderr: NodeJS.WritableStream, printed: Set<string>): void {
  const actions = event.actions;
  if (!Array.isArray(actions)) return;
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    const row = action as ProgressAction;
    const settled = typeof row.durationMs === 'number' || typeof row.success === 'boolean' || row.error != null;
    if (!settled) continue;
    const name = typeof row.tool === 'string' ? row.tool : 'tool';
    const key = typeof row.id === 'string' && row.id ? row.id : `${name}:${toolProgressLine(row)}`;
    if (printed.has(key)) continue;
    printed.add(key);
    stderr.write(`${toolProgressLine(row)}\n`);
  }
}

function observeEvent(
  event: SSEEvent,
  request: RunRequest,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  text: string[],
  streamOrder: StreamOrder,
  printedTools: Set<string>,
): number {
  if (request.streamJson) writeStreamJsonEvent(streamOrder, event, stdout);
  if (event.type === 'content' && typeof event.content === 'string') {
    text.push(event.content);
    if (!request.json && !request.streamJson) stdout.write(event.content);
  }
  if (!request.json && !request.streamJson) {
    if (String(event.type) === 'executed_actions') writeToolProgress(event, stderr, printedTools);
    if (event.type === 'tool_call') {
      const name = typeof event.payload?.name === 'string' ? event.payload.name : 'tool';
      stderr.write(`tool ${name}\n`);
    }
  }
  if (event.type === 'error') {
    const message = typeof event.message === 'string' ? event.message : 'error';
    if (!request.streamJson) stderr.write(`${message}\n`);
    if (event.code === 'chat_busy') return 6;
    if (message.includes('storage upgrade blocked') || message.includes('newer than this program')) return 75;
    return 1;
  }
  if (event.type === 'budget_exhausted') {
    if (!request.streamJson) stderr.write('budget exhausted\n');
    return 4;
  }
  return 0;
}
