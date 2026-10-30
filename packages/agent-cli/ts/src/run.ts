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
  const spec: ApprovalSpec = { policy: request.policy, answerAsk: request.policy === 'allow-all' };
  const approvals = watchApprovals(client, spec, request, stdout, autoAnswered, () => {
    deniedApproval = true;
  });
  try {
    for await (const event of client.stream(
      `/api/v2/chats/${encodeURIComponent(chatId)}/send`,
      { message: messageText(request), ...(request.agentId ? { agentId: request.agentId } : {}) },
      signal,
    )) {
      const next = observeEvent(event, request, stdout, stderr, text);
      if (next !== 0) exitCode = next;
    }
  } finally {
    approvals.stop();
  }
  if (signal.aborted && exitCode === 0) exitCode = 1;
  if (deniedApproval) exitCode = 3;
  if (client.lastStatus === 409) exitCode = 6;
  if (request.json) {
    stdout.write(`${JSON.stringify({
      ok: exitCode === 0,
      chatId,
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

function watchApprovals(
  client: AgentClient,
  spec: ApprovalSpec,
  request: RunRequest,
  stdout: NodeJS.WritableStream,
  autoAnswered: AutoAnswered[],
  onDenied: () => void,
): { stop: () => void } {
  let stopped = false;
  const loop = (async () => {
    for await (const event of client.events()) {
      if (stopped) return;
      if (event.channel === 'approval:request') {
        const prompt = event.payload as { requestId?: string; toolName?: string; category?: string; mode?: string };
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
        if (request.streamJson) stdout.write(`${JSON.stringify({ type: 'auto_answered', ...record })}\n`);
        await client.decideApproval(prompt.requestId, kind);
      } else if (event.channel === 'ask-user:request') {
        const prompt = event.payload as { requestId?: string; prompt?: string; questions?: { id: string }[] };
        if (!prompt.requestId) continue;
        if (spec.answerAsk) {
          const questions = prompt.questions?.length ? prompt.questions : [{ id: 'answer' }];
          const record: AutoAnswered = { kind: 'ask_user', prompt: prompt.prompt ?? '' };
          autoAnswered.push(record);
          if (request.streamJson) stdout.write(`${JSON.stringify({ type: 'auto_answered', ...record })}\n`);
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

function observeEvent(
  event: SSEEvent,
  request: RunRequest,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  text: string[],
): number {
  if (request.streamJson) stdout.write(`${JSON.stringify(event)}\n`);
  if (event.type === 'content' && typeof event.content === 'string') {
    text.push(event.content);
    if (!request.json && !request.streamJson) stdout.write(event.content);
  }
  if (event.type === 'tool_call' && !request.json && !request.streamJson) {
    const name = typeof event.payload?.name === 'string' ? event.payload.name : 'tool';
    stderr.write(`tool ${name}\n`);
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
