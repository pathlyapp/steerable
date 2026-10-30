/** 侧栏会话行快捷键。改这个表即可重绑，组件不要写死键名。 */
export const chatRowKeys = {
  rename: 'F2',
} as const;

/** 当前会话标题写进窗口标题；没有会话时只留产品名。 */
export function chatWindowTitle(chatTitle: string | undefined, brand: string): string {
  const title = chatTitle?.trim();
  return title ? `${title} — ${brand}` : brand;
}
