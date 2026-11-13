/**
 * Friendly timestamp formatter shared by `UserMessage` / `AssistantMessage`.
 * Today → `HH:MM`, other days → `MM-DD HH:MM`.
 *
 * Direct port of the helper from
 * `deeppath/apps/web/src/app/goals/desktop/components/ChatPanel/MessageList/UserMessage.tsx`.
 */
export function getFriendlyDate(date: Date): string {
  const now = new Date();
  const isToday = now.toDateString() === date.toDateString();
  if (isToday) {
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const time = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${month}-${day} ${time}`;
}

/** Fork source bar: month, day, and 24-hour time from the new chat's createdAt. */
export function forkSourceTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}
