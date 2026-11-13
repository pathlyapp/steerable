/**
 * 会话最后活动时间变了之后通知宿主。
 * SQLite 的 data_version 看不到本连接自己的提交，所以不能靠 store:changed
 * 把这次更新送到侧边栏。
 */

export interface ChatActivity {
  chatId: string;
  updatedAt: string;
}

type ChatActivityListener = (activity: ChatActivity) => void;

const listeners = new Set<ChatActivityListener>();

/** 订阅会话活动。返回解除订阅。 */
export function subscribeChatActivity(listener: ChatActivityListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 通知所有订阅者。没有订阅者时不做任何事。 */
export function emitChatActivity(activity: ChatActivity): void {
  for (const listener of listeners) listener(activity);
}
