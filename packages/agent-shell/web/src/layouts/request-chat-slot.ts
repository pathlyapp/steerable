/**
 * 让对话里的文件点击打开右侧栏位。
 *
 * 直接通知布局：没有这个标签就打开，已经打开就切过去。整栏收着时一并展开。
 */

const listeners = new Set<(slotId: string) => void>();
const followListeners = new Set<(slotId: string) => void>();

/** 打开并聚焦这个栏位。 */
export function requestChatSlot(slotId: string): void {
  for (const listener of listeners) listener(slotId);
}

/** 布局挂上后接收请求。返回取消订阅。 */
export function subscribeChatSlotRequests(
  listener: (slotId: string) => void,
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
export function followChatSlot(slotId: string): void {
  for (const listener of followListeners) listener(slotId);
}

/** 布局接收「跟着对话换栏位」的请求。返回取消订阅。 */
export function subscribeChatSlotFollows(
  listener: (slotId: string) => void,
): () => void {
  followListeners.add(listener);
  return () => {
    followListeners.delete(listener);
  };
}
