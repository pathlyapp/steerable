import fs from 'node:fs';
import path from 'node:path';

import { chatAttachmentsDirPath } from '../attachments.js';
import { canonicalFencePath } from '../fence-path.js';
import { replacePathPrefix } from './history-edit.js';
import { chatWorkspacePath } from '../project-home.js';

/** 无项目会话工作区复制上限。产品配置 `forkWorkspaceMaxBytes` 可以改。 */
export const DEFAULT_FORK_WORKSPACE_MAX_BYTES = 500 * 1024 * 1024;

/** 目录里普通文件的字节数。不跟随符号链接。目录不存在时为 0。 */
export function directorySizeBytes(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        total += fs.statSync(full).size;
      } catch {
        // 统计期间文件消失则跳过。
      }
    }
  }
  return total;
}

/** 复制目录。源不存在时什么也不做。目标已存在则失败，避免盖住别的会话。 */
export async function copyForkDirectory(src: string, dst: string): Promise<void> {
  if (!fs.existsSync(src)) return;
  await fs.promises.cp(src, dst, {
    recursive: true,
    errorOnExist: true,
    verbatimSymlinks: true,
  });
}

export async function removeForkDirectory(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true });
}

/** 登记路径和它的真实路径都要换，`/tmp` 与 `/private/tmp` 指向同一目录。 */
function forkPrefixPairs(from: string, to: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [[from, to]];
  const realFrom = canonicalFencePath(path.resolve(from));
  const realTo = canonicalFencePath(path.resolve(to));
  if (realFrom !== from) pairs.push([realFrom, realTo]);
  return pairs;
}

/** 把旧会话的附件目录和工作区前缀换成新会话的。只换完整路径前缀。 */
export function forkPathRewriter(oldChatId: string, newChatId: string): (text: string) => string {
  const pairs = [
    ...forkPrefixPairs(chatAttachmentsDirPath(oldChatId), chatAttachmentsDirPath(newChatId)),
    ...forkPrefixPairs(chatWorkspacePath(oldChatId), chatWorkspacePath(newChatId)),
  ].sort((left, right) => right[0].length - left[0].length);
  return (text) => pairs.reduce((current, [from, to]) => replacePathPrefix(current, from, to), text);
}
