/**
 * Pure helper for the `/regenerate` route in `router.ts`.
 *
 * Regenerating an assistant reply means: find the user turn that prompted it,
 * delete that assistant message and everything after it, then rerun as if
 * that user turn just happened. This module only computes *which* text to
 * re-run with — the actual deletion is DB I/O and stays in `router.ts` /
 * `storage/index.ts` (which can't be unit-tested here: `better-sqlite3` is
 * compiled against Electron's ABI and can't load under plain Node/vitest).
 */

export interface RegenerateMessageLike {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  messageMetadata?: string | null;
}

function isInternalUserMessage(message: RegenerateMessageLike): boolean {
  if (message.role !== 'user' || !message.messageMetadata) return false;
  try {
    const metadata = JSON.parse(message.messageMetadata) as {
      internal?: unknown;
      trigger?: unknown;
    };
    return (
      metadata.internal === true &&
      (metadata.trigger === 'goal' || metadata.trigger === 'loop')
    );
  } catch {
    return false;
  }
}

export type EditUserMessageResolution =
  | {
      ok: true;
      targetMessageId: string;
      userOrdinal: number;
    }
  | {
      ok: false;
      reason: 'not_found' | 'not_user' | 'not_latest_user';
    };

/**
 * Resolve the target user message for `POST /api/v2/chats/:id/messages/:messageId/edit`.
 *
 * Accepts `'latest'` to address the most recent non-internal user turn (used by
 * live UI turns whose client message id has not yet been hydrated from SQLite),
 * or an explicit persisted `messageId` (rejected with `not_latest_user` if a
 * newer user turn already follows it).
 */
export function resolveEditUserMessageContext(
  messagesAsc: RegenerateMessageLike[],
  targetMessageId: string,
): EditUserMessageResolution {
  let latestUserIdx = -1;
  for (let i = messagesAsc.length - 1; i >= 0; i -= 1) {
    if (messagesAsc[i].role === 'user' && !isInternalUserMessage(messagesAsc[i])) {
      latestUserIdx = i;
      break;
    }
  }

  let targetIdx: number;
  if (targetMessageId === 'latest') {
    if (latestUserIdx === -1) {
      return { ok: false, reason: 'not_found' };
    }
    targetIdx = latestUserIdx;
  } else {
    targetIdx = messagesAsc.findIndex((m) => m.id === targetMessageId);
    if (targetIdx === -1) {
      return { ok: false, reason: 'not_found' };
    }
    if (messagesAsc[targetIdx].role !== 'user' || isInternalUserMessage(messagesAsc[targetIdx])) {
      return { ok: false, reason: 'not_user' };
    }
    if (targetIdx !== latestUserIdx) {
      return { ok: false, reason: 'not_latest_user' };
    }
  }

  let userOrdinal = 0;
  for (let i = 0; i < targetIdx; i += 1) {
    if (messagesAsc[i].role === 'user') {
      userOrdinal += 1;
    }
  }

  return {
    ok: true,
    targetMessageId: messagesAsc[targetIdx].id,
    userOrdinal,
  };
}

export type RegenerateResolution =
  | { ok: true; userMessageText: string }
  | { ok: false; reason: 'not_found' | 'not_assistant' };

const FALLBACK_TEXT = '请基于上一轮内容重新生成回复。';

/**
 * @param messagesAsc Full chat history, chronologically ascending (oldest first).
 * @param targetMessageId The assistant message being regenerated.
 */
export function resolveRegenerateContext(
  messagesAsc: RegenerateMessageLike[],
  targetMessageId: string,
): RegenerateResolution {
  const targetIdx = messagesAsc.findIndex((m) => m.id === targetMessageId);
  if (targetIdx === -1) {
    return { ok: false, reason: 'not_found' };
  }
  if (messagesAsc[targetIdx].role !== 'assistant') {
    return { ok: false, reason: 'not_assistant' };
  }
  let precedingUserText: string | null = null;
  for (let i = targetIdx - 1; i >= 0; i -= 1) {
    if (messagesAsc[i].role === 'user') {
      precedingUserText = messagesAsc[i].content.trim();
      break;
    }
  }
  return { ok: true, userMessageText: precedingUserText || FALLBACK_TEXT };
}

/**
 * W5-2: the fork-point address for a non-destructive regenerate, as a
 * user-message ordinal — the prompting user turn is the last user message
 * before the target, i.e. (count of user messages before the target) - 1.
 * The sidecar's `resolve_fork_seq(user_index=…)` resolves the same ordinal
 * against the durable record (steer injections are a separate record kind,
 * so user ordinals align between the two stores). Returns -1 when no user
 * message precedes the target (the FALLBACK_TEXT case) — not addressable,
 * the caller falls back to legacy truncate-and-rerun.
 */
export function resolveRegenerateForkOrdinal(
  messagesAsc: RegenerateMessageLike[],
  targetMessageId: string,
): number {
  const targetIdx = messagesAsc.findIndex((m) => m.id === targetMessageId);
  if (targetIdx === -1) return -1;
  let ordinal = -1;
  for (let i = 0; i < targetIdx; i += 1) {
    if (messagesAsc[i].role === 'user') ordinal += 1;
  }
  return ordinal;
}

export type RegenerateTruncatePlan =
  | { proceed: true }
  | { proceed: false; message: string };

/**
 * Whether regenerate may delete the target reply, given the fork attempt that
 * was supposed to preserve it as a branch.
 *
 * A declined address is the protocol's documented fallback and proceeds. A fork
 * that failed instead of answering revokes the permission to delete: the control
 * offers regenerate as non-destructive, and truncating anyway would drop the
 * reply's row and interleave the new one into the same record, with no branch and
 * no notice. Refusing leaves the reply where the user can still see it and lets
 * them retry once the sidecar answers again.
 *
 * @param fork `null` when no sidecar was attached, so no record existed to fork.
 */
export function planRegenerateTruncate(
  fork: { ok: boolean; declined?: boolean; reason?: string } | null,
): RegenerateTruncatePlan {
  if (!fork || fork.ok || fork.declined) return { proceed: true };
  return {
    proceed: false,
    message:
      '无法重新生成：旧回复未能保留为分支，' +
      `已放弃改动以免丢失它（${fork.reason ?? '未知原因'}）。请稍后重试。`,
  };
}
