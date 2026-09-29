import fs from 'node:fs/promises';
import path from 'node:path';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export interface MentionToken {
  start: number;
  query: string;
}

export interface FilePick {
  label: string;
  insert: string;
  directory: boolean;
}

export interface SavedFile {
  name: string;
  path: string;
  error?: string;
}

/** The `@query` touching the cursor, if the `@` starts a token. */
export function mentionAt(text: string, cursor: number): MentionToken | null {
  const at = Math.max(0, Math.min(cursor, text.length));
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, at));
  if (!match) return null;
  const query = match[2] ?? '';
  return { start: at - query.length - 1, query };
}

/** Files and directories under `root` whose relative path matches `@query`. */
export async function completeFiles(root: string, query: string, limit = 8): Promise<FilePick[]> {
  const normalized = query.replaceAll('\\', '/');
  const slash = normalized.lastIndexOf('/');
  const dirPart = slash >= 0 ? normalized.slice(0, slash) : '';
  const prefix = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  let names: string[];
  try {
    names = await fs.readdir(path.resolve(root, dirPart));
  } catch {
    return [];
  }
  const visible = names
    .filter((name) => (prefix.startsWith('.') ? true : !name.startsWith('.')))
    .filter((name) => name.startsWith(prefix))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 40);
  const picks: FilePick[] = [];
  for (const name of visible) {
    const full = path.join(path.resolve(root, dirPart), name);
    let directory = false;
    try {
      directory = (await fs.stat(full)).isDirectory();
    } catch {
      continue;
    }
    const relative = path.relative(root, full).split(path.sep).join('/');
    const shown = directory ? `${relative}/` : relative;
    picks.push({
      label: shown,
      insert: `@${shown}${directory ? '' : ' '}`,
      directory,
    });
  }
  picks.sort((left, right) => Number(right.directory) - Number(left.directory) || left.label.localeCompare(right.label));
  return picks.slice(0, limit);
}

export function isImagePath(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  return dot >= 0 && IMAGE_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

/** Append stored paths the way the web composer does, so the agent can read them back. */
export function attachmentMessage(text: string, files: Array<{ path: string }>): string {
  if (files.length === 0) return text;
  const refs = files.map((file) => `- \`${file.path}\``).join('\n');
  const block = `相关文件：\n${refs}`;
  return text ? `${text}\n\n---\n${block}` : block;
}
