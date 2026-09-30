import { applyChildEvent, childLines, type ChildEvent } from './children.js';

export interface ToolAction {
  id?: string;
  tool?: string;
  arguments?: unknown;
  view?: { title?: string };
  result?: unknown;
  success?: boolean;
  error?: unknown;
  durationMs?: number;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

export function toolStatus(action: ToolAction): string {
  const settled = typeof action.durationMs === 'number' || typeof action.success === 'boolean' || action.error != null;
  if (!settled) return '…';
  const mark = action.success === false || action.error != null ? '✗' : '✓';
  const duration = typeof action.durationMs === 'number' ? formatDuration(action.durationMs) : '';
  return duration ? `${mark} ${duration}` : mark;
}

export function toolOutput(action: ToolAction): string {
  const error = textOf(action.error);
  if (error) return clip(error);
  return clip(textOf(action.result));
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
