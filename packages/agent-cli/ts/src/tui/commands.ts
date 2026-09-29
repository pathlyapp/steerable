import type { FilePick } from './files.js';

const COMMANDS = [
  { name: 'new', hint: '新会话' },
  { name: 'model', hint: '查看或切换模型' },
  { name: 'attach', hint: '附加文件' },
  { name: 'clear', hint: '清屏' },
  { name: 'help', hint: '帮助' },
] as const;

export interface SlashToken {
  start: number;
  query: string;
}

/** A `/command` at the start of the draft, touching the cursor. */
export function slashAt(text: string, cursor: number): SlashToken | null {
  const at = Math.max(0, Math.min(cursor, text.length));
  const head = text.slice(0, at);
  if (head.includes('\n')) return null;
  const match = /^\/([^\s]*)$/.exec(head);
  if (!match) return null;
  return { start: 0, query: match[1] ?? '' };
}

/** Commands already implemented by the composer, filtered by the text after `/`. */
export function completeSlash(query: string): FilePick[] {
  const needle = query.toLowerCase();
  return COMMANDS
    .filter((command) => command.name.startsWith(needle))
    .map((command) => ({
      label: `/${command.name} ${command.hint}`,
      insert: `/${command.name} `,
      directory: false,
    }));
}
