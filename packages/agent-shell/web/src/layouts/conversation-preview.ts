/**
 * 右侧预览跟着当前对话走，按会话分开，不共用一条全局路径。
 *
 * 停在对话底部时显示最近一轮能预览的文件；往上翻时换成看着的那一轮。
 * 点了某一份文件就先钉住它，直到翻到别的回合。
 */

export interface ConversationPreviewTarget {
  chatId: string;
  messageId: string;
  path: string;
}

const targets = new Map<string, ConversationPreviewTarget>();
const pins = new Map<string, { messageId: string; path: string }>();
const listeners = new Set<(target: ConversationPreviewTarget) => void>();

function emit(target: ConversationPreviewTarget): void {
  const previous = targets.get(target.chatId);
  targets.set(target.chatId, target);
  if (
    previous
    && previous.messageId === target.messageId
    && previous.path === target.path
  ) {
    return;
  }
  for (const listener of listeners) listener(target);
}

/** 从 `#/agent/<chatId>` 取出当前会话。点文件时布局还没把 id 传进来。 */
export function chatIdFromHash(hash: string): string | null {
  const match = /#\/agent\/([^/?#]+)/.exec(hash);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function peekConversationPreview(chatId: string): ConversationPreviewTarget | null {
  return targets.get(chatId) ?? null;
}

export function publishConversationPreview(target: ConversationPreviewTarget): void {
  if (!target.chatId || !target.path) return;
  const pin = pins.get(target.chatId);
  if (!pin) {
    emit(target);
    return;
  }
  if (pin.messageId === '' || pin.messageId === target.messageId) {
    if (pin.messageId === '') {
      pins.set(target.chatId, { messageId: target.messageId, path: pin.path });
    }
    emit({ ...target, path: pin.path });
    return;
  }
  pins.delete(target.chatId);
  emit(target);
}

/** 点开的文件先于「这一轮的主文件」。翻到别的回合后钉自动松开。 */
export function pinConversationPreview(
  chatId: string,
  path: string,
  messageId = '',
): void {
  if (!chatId || !path) return;
  pins.set(chatId, { messageId, path });
  emit({ chatId, messageId, path });
}

export function subscribeConversationPreview(
  listener: (target: ConversationPreviewTarget) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetConversationPreviewForTests(): void {
  targets.clear();
  pins.clear();
}
