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

/** Newest-first history copied in time order. */
export function forkHistory(messages: readonly StoredTurn[]): HistoryWrite[] {
  return messages.slice().reverse().map((message) => ({
    role: message.role,
    content: message.content,
    messageMetadata: message.messageMetadata ?? null,
  }));
}
