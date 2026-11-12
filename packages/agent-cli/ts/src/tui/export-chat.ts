export function markdownChat(
  title: string,
  messages: readonly { role?: string; content?: string }[],
): string {
  const parts = [`# ${title}`, ''];
  for (const message of messages) {
    parts.push(`## ${message.role ?? ''}`, '', message.content ?? '', '');
  }
  return `${parts.join('\n').replace(/\n$/, '')}\n`;
}
