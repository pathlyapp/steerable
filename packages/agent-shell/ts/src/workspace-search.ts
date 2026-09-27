/**
 * 宿主侧 grep / glob。
 *
 * 调用方先把起点收进项目围栏。这里只在该目录内遍历，跳过符号链接，
 * 并丢掉依赖目录和超大文件。命中数有上限。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '.steerable',
  '__pycache__',
  '.venv',
  'venv',
]);

const MAX_FILES = 4_000;
const MAX_MATCHES = 80;
const MAX_FILE_BYTES = 1_000_000;
const MAX_DEPTH = 20;

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface GrepResult {
  success: boolean;
  matches?: SearchHit[];
  truncated?: boolean;
  filesScanned?: number;
  error?: string;
  needsFollowup?: boolean;
}

export interface GlobResult {
  success: boolean;
  files?: string[];
  truncated?: boolean;
  error?: string;
  needsFollowup?: boolean;
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll('\\', '/');
  const withPrefix = normalized.includes('/') ? normalized : `**/${normalized}`;
  let out = '';
  for (let i = 0; i < withPrefix.length; i += 1) {
    const char = withPrefix[i];
    if (char === '*' && withPrefix[i + 1] === '*') {
      if (withPrefix[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
      continue;
    }
    if (char === '*') {
      out += '[^/]*';
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    if ('\\^$+?.()|{}[]'.includes(char)) out += `\\${char}`;
    else out += char;
  }
  return new RegExp(`^${out}$`);
}

async function walk(
  root: string,
  visit: (absolute: string, relative: string) => Promise<boolean | void>,
): Promise<{ truncated: boolean; files: number }> {
  let files = 0;
  let truncated = false;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const next = queue.pop();
    if (!next) break;
    let entries;
    try {
      entries = await readdir(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(next.dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || next.depth >= MAX_DEPTH) continue;
        queue.push({ dir: absolute, depth: next.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      if (files > MAX_FILES) {
        truncated = true;
        return { truncated, files };
      }
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stop = await visit(absolute, relative);
      if (stop === true) {
        truncated = true;
        return { truncated, files };
      }
    }
  }
  return { truncated, files };
}

export async function searchGrep(input: {
  root: string;
  pattern: string;
  glob?: string;
}): Promise<GrepResult> {
  const pattern = input.pattern.trim();
  if (!pattern) return { success: false, error: 'pattern 不能为空', needsFollowup: true };
  let matcher: RegExp;
  try {
    matcher = new RegExp(pattern);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `无效的正则：${message}`, needsFollowup: true };
  }
  let fileFilter: RegExp | null = null;
  if (input.glob && input.glob.trim()) {
    try {
      fileFilter = globToRegExp(input.glob.trim());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `无效的 glob：${message}`, needsFollowup: true };
    }
  }
  const matches: SearchHit[] = [];
  const walked = await walk(input.root, async (absolute, relative) => {
    if (fileFilter && !fileFilter.test(relative)) return;
    let info;
    try {
      info = await stat(absolute);
    } catch {
      return;
    }
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return;
    let text: string;
    try {
      text = await readFile(absolute, 'utf8');
    } catch {
      return;
    }
    if (text.includes('\0')) return;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!matcher.test(lines[i])) continue;
      matches.push({ path: relative, line: i + 1, text: lines[i].slice(0, 400) });
      if (matches.length >= MAX_MATCHES) return true;
    }
    return undefined;
  });
  return {
    success: true,
    matches,
    truncated: walked.truncated || matches.length >= MAX_MATCHES,
    filesScanned: walked.files,
  };
}

export async function searchGlob(input: { root: string; pattern: string }): Promise<GlobResult> {
  const pattern = input.pattern.trim();
  if (!pattern) return { success: false, error: 'pattern 不能为空', needsFollowup: true };
  let matcher: RegExp;
  try {
    matcher = globToRegExp(pattern);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `无效的 glob：${message}`, needsFollowup: true };
  }
  const files: string[] = [];
  const walked = await walk(input.root, async (_absolute, relative) => {
    if (!matcher.test(relative)) return;
    files.push(relative);
    if (files.length >= MAX_MATCHES) return true;
    return undefined;
  });
  files.sort();
  return {
    success: true,
    files,
    truncated: walked.truncated || files.length >= MAX_MATCHES,
  };
}
