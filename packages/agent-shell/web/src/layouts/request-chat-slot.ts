/**
 * 让对话里的文件点击打开右侧栏位。
 *
 * 直接通知布局：没有这个标签就打开，已经打开就切过去。整栏收着时一并展开。
 */

const LEGACY_RESOURCE_SEPARATOR = ':resource:';

export interface ChatSlotRequest {
  kind: string;
  contentId?: string;
  title?: string;
}

const listeners = new Set<(request: ChatSlotRequest) => void>();
const followListeners = new Set<(request: ChatSlotRequest) => void>();

/** 只用于读取 v1 持久化的 `slotId:resource:<encoded path>`。 */
export function parseLegacyChatSlotTabId(value: string): ChatSlotRequest {
  const separator = value.indexOf(LEGACY_RESOURCE_SEPARATOR);
  if (separator < 0) return { kind: value };
  const kind = value.slice(0, separator);
  const encoded = value.slice(separator + LEGACY_RESOURCE_SEPARATOR.length);
  if (!kind || !encoded) return { kind: value };
  try {
    return { kind, contentId: decodeURIComponent(encoded) };
  } catch {
    return { kind: value };
  }
}

/** 打开并聚焦这个栏位。 */
export function requestChatSlot(kind: string, options: Omit<ChatSlotRequest, 'kind'> = {}): void {
  const request = { kind, ...options };
  for (const listener of listeners) listener(request);
}

/** 布局挂上后接收请求。返回取消订阅。 */
export function subscribeChatSlotRequests(
  listener: (request: ChatSlotRequest) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 对话滚动或新产物把右侧内容换到这个栏位。
 * 和点击不同：栏位关着时不弹出，正在看终端时也不抢走。
 */
export function followChatSlot(kind: string, options: Omit<ChatSlotRequest, 'kind'> = {}): void {
  const request = { kind, ...options };
  for (const listener of followListeners) listener(request);
}

/** 布局接收「跟着对话换栏位」的请求。返回取消订阅。 */
export function subscribeChatSlotFollows(
  listener: (request: ChatSlotRequest) => void,
): () => void {
  followListeners.add(listener);
  return () => {
    followListeners.delete(listener);
  };
}
