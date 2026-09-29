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
