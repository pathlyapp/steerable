/**
 * 让对话里的文件点击打开右侧栏位。
 *
 * 面板菜单只在弹出时挂进文档，文件点击时那个按钮往往不在。
 * 这里直接通知布局：没有这个标签就打开，已经打开就切过去。
 */

const listeners = new Set<(slotId: string) => void>();

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
