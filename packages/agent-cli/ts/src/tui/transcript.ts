import { applyChildEvent, childLines, type ChildEvent } from './children.js';
import { cliText } from '../copy.js';

export interface ToolAction {
  id?: string;
  tool?: string;
  arguments?: unknown;
  view?: { title?: string };
  result?: unknown;
  success?: boolean;
  error?: unknown;
  durationMs?: number;
  approval?: { kind?: string; cached?: boolean; auto?: boolean };
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

export function toolStatus(action: ToolAction): string {
  const settled = typeof action.durationMs === 'number' || typeof action.success === 'boolean' || action.error != null;
  if (!settled) return '…';
  const failed = action.success === false || action.error != null;
  if (!failed && askUserReplay(action)?.auto) return `✓ ${cliText('tui.toolAutoAnswer')}`;
  const mark = failed ? '✗' : '✓';
  const duration = typeof action.durationMs === 'number' ? formatDuration(action.durationMs) : '';
  const base = duration ? `${mark} ${duration}` : mark;
  if (action.approval?.kind === 'allow_for_session' && action.approval.cached === true) {
    return `${base} ${cliText('tui.toolSessionAllow')}`;
  }
  if (!failed && action.approval?.auto === true) return `${base} ${cliText('tui.toolAuto')}`;
  return base;
}

export function toolOutput(action: ToolAction): string {
  const error = textOf(action.error);
  if (error) return clip(error);
  // A reopened chat only has the stored result object, which has no string field the generic extractor reads.
  const replay = askUserReplay(action);
  if (replay) return clip(replay.lines);
  return clip(textOf(action.result));
}

/** First question, for the folded tool row. The intro stays out of that column. */
export function askRowSummary(action: ToolAction): string {
  if (action.tool !== 'ask_user') return '';
  return firstQuestionText(action.result) || firstQuestionText(action.arguments);
}

function askUserReplay(action: ToolAction): { lines: string; auto: boolean } | null {
  if (action.tool !== 'ask_user') return null;
  const record = unwrapAsk(action.result);
  if (!record) return null;
  const answers = record.answers;
  const asked: string[] = [];
  const rendered: string[] = [];
  for (const question of record.questions) {
    if (!question || typeof question !== 'object') continue;
    const row = question as { id?: unknown; text?: unknown };
    const text = typeof row.text === 'string' ? row.text.trim() : '';
    if (!text) continue;
    asked.push(text);
    const id = typeof row.id === 'string' ? row.id : '';
    rendered.push(id ? answerText(answers[id]) : '');
  }
  if (asked.length === 0) return null;
  const phrase = cliText('ask.unattended');
  const filled = rendered.filter((value) => value.length > 0);
  const first = filled[0];
  const shared = first !== undefined && filled.length === asked.length && filled.every((value) => value === first);
  const auto = record.unattended === true || (shared && first === phrase);
  const lines = shared
    ? [...asked.map((text) => `问 ${text}`), `答 ${first}`].join('\n')
    : asked.map((text, index) => {
        const answer = rendered[index] ?? '';
        return answer ? `问 ${text}\n答 ${answer}` : `问 ${text}`;
      }).join('\n');
  return { lines, auto };
}

function unwrapAsk(result: unknown): { questions: unknown[]; answers: Record<string, unknown>; unattended?: boolean } | null {
  if (typeof result === 'string') {
    const trimmed = result.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return unwrapAsk(parsed);
    } catch {
      return null;
    }
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const record = result as { questions?: unknown; answers?: unknown; data?: unknown; value?: unknown; unattended?: unknown };
  if (Array.isArray(record.questions) && record.answers && typeof record.answers === 'object' && !Array.isArray(record.answers)) {
    return {
      questions: record.questions,
      answers: record.answers as Record<string, unknown>,
      ...(record.unattended === true ? { unattended: true } : {}),
    };
  }
  if (record.value && typeof record.value === 'object') {
    const inner = unwrapAsk(record.value);
    if (inner) return record.unattended === true ? { ...inner, unattended: true } : inner;
  }
  if (record.data && typeof record.data === 'object') {
    const inner = unwrapAsk(record.data);
    if (inner) return record.unattended === true ? { ...inner, unattended: true } : inner;
  }
  return null;
}

function firstQuestionText(value: unknown): string {
  const unwrapped = unwrapAsk(value);
  const questions = unwrapped?.questions ?? questionList(value);
  for (const question of questions) {
    if (!question || typeof question !== 'object') continue;
    const text = (question as { text?: unknown }).text;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

function questionList(value: unknown): unknown[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const questions = (value as { questions?: unknown }).questions;
  return Array.isArray(questions) ? questions : [];
}

function answerText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .join('、');
}

export function plainMarkdown(source: string): string {
  const out: string[] = [];
  let fence = false;
  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    if (line.trim().startsWith('```')) {
      fence = !fence;
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    out.push(line
      .replace(/^#{1,6}\s+/, '')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/~~([^~\n]+)~~/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1'));
  }
  return out.join('\n');
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of ['stdout', 'output', 'content', 'text', 'message', 'error']) {
    if (typeof record[key] === 'string' && record[key]) return record[key];
  }
  const data = record.data;
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') return textOf(data);
  return '';
}

function clip(text: string): string {
  const trimmed = text.replace(/\s+$/g, '');
  return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}…` : trimmed;
}

export interface StoredMessage {
  role?: string;
  content?: string;
  createdAt?: string | number;
  messageMetadata?: string | null;
}

export type HistoryRow =
  | { kind: 'user' | 'assistant' | 'tree' | 'reasoning'; text: string }
  | { kind: 'tool'; action: ToolAction };

/** The list endpoint is newest-first. Dated lists are ordered by time; undated lists stay as given. */
export function historyRows(messages: readonly StoredMessage[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const message of inTimeOrder(messages)) {
    const meta = parseMeta(message.messageMetadata);
    if (message.role === 'user') {
      if (meta.internal === true) {
        const trigger = meta.trigger === 'loop' ? 'Loop 触发' : '目标续跑';
        rows.push({ kind: 'tree', text: trigger });
        continue;
      }
      rows.push({ kind: 'user', text: message.content ?? '' });
      continue;
    }
    const timeline = Array.isArray(meta.timeline) ? meta.timeline : null;
    if (timeline) {
      let sawText = false;
      for (const block of timeline) {
        if (!block || typeof block !== 'object') continue;
        const record = block as Record<string, unknown>;
        if (record.type === 'text' && typeof record.content === 'string' && record.content.length > 0) {
          sawText = true;
          rows.push({ kind: 'assistant', text: record.content });
        } else if (record.type === 'reasoning' && typeof record.content === 'string' && record.content.length > 0) {
          rows.push({ kind: 'reasoning', text: record.content });
        } else if (record.type === 'tools' && Array.isArray(record.actions)) {
          for (const action of record.actions) {
            if (action && typeof action === 'object') rows.push({ kind: 'tool', action: action as ToolAction });
          }
        }
      }
      if (!sawText && message.content) rows.push({ kind: 'assistant', text: message.content });
    } else {
      if (message.content) rows.push({ kind: 'assistant', text: message.content });
      const actions = Array.isArray(meta.executedActions) ? meta.executedActions : [];
      for (const action of actions) {
        if (action && typeof action === 'object') rows.push({ kind: 'tool', action: action as ToolAction });
      }
    }
    appendChildren(rows, meta.orchestrationChildEvents);
  }
  return rows;
}

function inTimeOrder(messages: readonly StoredMessage[]): StoredMessage[] {
  if (messages.length < 2) return [...messages];
  const times = messages.map((message) => message.createdAt == null ? null : String(message.createdAt));
  if (times.some((time) => time == null)) return [...messages];
  const first = times[0] ?? '';
  const last = times[times.length - 1] ?? '';
  if (first > last) return [...messages].reverse();
  return [...messages];
}

function appendChildren(rows: HistoryRow[], events: unknown): void {
  if (!Array.isArray(events)) return;
  let children: Parameters<typeof applyChildEvent>[0] = [];
  for (const event of events) {
    if (event && typeof event === 'object') children = applyChildEvent(children, event as ChildEvent);
  }
  for (const line of childLines(children)) rows.push({ kind: 'tree', text: line });
}

function parseMeta(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch (error) {
    void error;
  }
  return {};
}
