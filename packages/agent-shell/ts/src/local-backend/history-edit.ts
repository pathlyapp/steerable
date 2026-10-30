export interface StoredTurn {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  messageMetadata?: string | null;
}

export interface HistoryWrite {
  role: StoredTurn['role'];
  content: string;
  messageMetadata: string | null;
}

/**
 * Newest-first history. The newest two messages stay. Older ones become one summary,
 * and the caller deletes from the oldest id (which removes the whole chat) before writing these back.
 */
export function compactHistory(
  messages: readonly StoredTurn[],
): { deleteFromId: string; writes: HistoryWrite[]; compacted: number } | null {
  if (messages.length <= 2) return null;
  const kept = messages.slice(0, 2);
  const older = messages.slice(2);
  const oldest = older[older.length - 1];
  if (!oldest) return null;
  const summary = older.slice().reverse().map((message) => {
    const text = message.content.replace(/\s+/g, ' ').trim();
    const clipped = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    return `${message.role}: ${clipped}`;
  }).join('\n');
  return {
    deleteFromId: oldest.id,
    compacted: older.length,
    writes: [
      { role: 'assistant', content: `已压缩 ${older.length} 条\n${summary}`, messageMetadata: null },
      ...kept.slice().reverse().map((message) => ({
        role: message.role,
        content: message.content,
        messageMetadata: message.messageMetadata ?? null,
      })),
    ],
  };
}

/** Newest-first. Cut from the newest user message through the reply after it. */
export function rewindFrom(messages: readonly StoredTurn[]): { deleteFromId: string; removed: number } | null {
  const index = messages.findIndex((message) => message.role === 'user');
  const target = index >= 0 ? messages[index] : undefined;
  if (!target) return null;
  return { deleteFromId: target.id, removed: index + 1 };
}

/**
 * Replace `from` only when it is a complete path prefix: the next character
 * is a separator or the end of the string. A longer name that merely starts
 * with the same characters is left alone. On Windows the match ignores
 * letter case and treats `/` and `\` as the same separator.
 */
export function replacePathPrefix(
  text: string,
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const source = from.replace(/[\\/]+$/, '');
  const target = to.replace(/[\\/]+$/, '');
  if (!source || prefixesEqual(source, target, platform)) return text;
  const win32 = platform === 'win32';
  let out = '';
  let cursor = 0;
  while (cursor < text.length) {
    const at = findPrefix(text, source, cursor, win32);
    if (at < 0) {
      out += text.slice(cursor);
      break;
    }
    const next = text[at + source.length];
    if (next === undefined || next === '/' || next === '\\') {
      out += text.slice(cursor, at) + target;
    } else {
      out += text.slice(cursor, at + source.length);
    }
    cursor = at + source.length;
  }
  return out;
}

function prefixesEqual(left: string, right: string, platform: NodeJS.Platform): boolean {
  return left.length === right.length && regionEquals(left, 0, right, platform === 'win32');
}

function findPrefix(text: string, source: string, fromIndex: number, win32: boolean): number {
  const limit = text.length - source.length;
  for (let index = fromIndex; index <= limit; index += 1) {
    if (regionEquals(text, index, source, win32)) return index;
  }
  return -1;
}

function regionEquals(text: string, at: number, source: string, win32: boolean): boolean {
  for (let index = 0; index < source.length; index += 1) {
    if (!charsEqual(text[at + index] ?? '', source[index] ?? '', win32)) return false;
  }
  return true;
}

function charsEqual(left: string, right: string, win32: boolean): boolean {
  if (left === right) return true;
  if (!win32) return false;
  if ((left === '/' || left === '\\') && (right === '/' || right === '\\')) return true;
  return left.toLowerCase() === right.toLowerCase();
}

function rewriteJsonValue(value: unknown, rewrite: (text: string) => string): unknown {
  if (typeof value === 'string') return rewrite(value);
  if (Array.isArray(value)) return value.map((item) => rewriteJsonValue(item, rewrite));
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      next[key] = rewriteJsonValue(item, rewrite);
    }
    return next;
  }
  return value;
}

function rewriteMetadata(raw: string | null | undefined, rewrite: (text: string) => string): string | null {
  if (!raw) return raw ?? null;
  try {
    return JSON.stringify(rewriteJsonValue(JSON.parse(raw), rewrite));
  } catch {
    return rewrite(raw);
  }
}

/** Newest-first history copied in time order. `rewrite` updates copied paths. */
export function forkHistory(
  messages: readonly StoredTurn[],
  rewrite: (text: string) => string = (text) => text,
): HistoryWrite[] {
  return messages.slice().reverse().map((message) => ({
    role: message.role,
    content: rewrite(message.content),
    messageMetadata: rewriteMetadata(message.messageMetadata, rewrite),
  }));
}
