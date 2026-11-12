/** Chat id from `#/agent/:chatId` (hash router) or `/agent/:chatId`. */
export function chatIdFromLocation(location: { pathname: string; hash: string }): string | null {
  const hashed = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  const raw = hashed || location.pathname;
  const match = raw.match(/\/agent\/([^/?#]+)/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** Stamp an unscoped prompt with the chat open when it arrived. */
export function bindPromptToActiveChat<T extends { chatId?: string }>(request: T): T {
  if (request.chatId) return request;
  const chatId = chatIdFromLocation(window.location);
  if (!chatId) return request;
  return { ...request, chatId };
}

/**
 * A prompt with a chat id belongs only to that chat.
 * A prompt without one stays visible only when the composer itself has no chat,
 * so an older request is still answerable.
 */
export function promptVisibleInChat(
  request: { chatId?: string },
  chatId: string | null | undefined,
): boolean {
  if (!request.chatId) return !chatId;
  return request.chatId === chatId;
}
