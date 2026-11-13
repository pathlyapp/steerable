/**
 * 项目默认家目录：`Documents/<应用名>/<项目名>/`。
 *
 * 新建项目不再等于「选一个已有文件夹」——项目是带名字的容器，
 * 家目录由本模块分配并创建。用户另加的源文件夹是额外可写根（含子目录），
 * 不替代这个家目录。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getBrand } from './brand.js';
import { getDocumentsDir } from './runtime.js';

const UNSAFE_DIR_CHARS = /[\\/:*?"<>|]/g;

/** 把 `~` / `~/…` 展开成绝对路径；其它输入原样（已 trim）。 */
export function expandUserPath(folder: string): string {
  const trimmed = folder.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export function sanitizeProjectDirName(name: string): string {
  const trimmed = name
    .trim()
    .replace(UNSAFE_DIR_CHARS, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '');
  return trimmed || '未命名项目';
}

/** `Documents/<应用显示名>`：该应用下所有托管项目的父目录。 */
export function appProjectsRoot(options?: {
  documentsDir?: string;
  appFolderName?: string;
}): string {
  const documents = options?.documentsDir ?? getDocumentsDir();
  const appName = options?.appFolderName ?? getBrand().displayName;
  return path.join(documents, sanitizeProjectDirName(appName));
}

/**
 * 为项目名分配尚未占用的家目录路径（不落盘）。
 * 已存在同名目录时追加 `-2`、`-3`…
 */
export function allocateProjectHome(
  projectName: string,
  options?: {
    documentsDir?: string;
    appFolderName?: string;
    exists?: (folderPath: string) => boolean;
  },
): string {
  const root = appProjectsRoot(options);
  const base = sanitizeProjectDirName(projectName);
  const exists = options?.exists ?? ((folderPath) => fs.existsSync(folderPath));
  let candidate = path.join(root, base);
  if (!exists(candidate)) return candidate;
  for (let i = 2; i < 1000; i += 1) {
    candidate = path.join(root, `${base}-${i}`);
    if (!exists(candidate)) return candidate;
  }
  throw new Error('无法分配项目目录：重名过多');
}

export function ensureProjectHome(folderPath: string): void {
  fs.mkdirSync(folderPath, { recursive: true });
}

/**
 * 把一批可写根落成真实目录，返回原列表（便于链式使用）。
 *
 * Linux 的 Landlock 在安装规则时逐个 open 这些路径，bwrap 则要 bind mount
 * 它们；声明了但还没建过的目录会让被沙箱的子进程直接起不来
 * （`writable root … does not exist`）。这与 supervisor 启动时对
 * `sandboxWritableRoots` 做的 mkdir 是同一个前置条件。
 *
 * 建不出来的根**留在列表里**：沙箱应当因此明确拒绝这次调用，而不是悄悄
 * 少一份写权限继续跑。
 */
export function ensureWritableRoots(roots: readonly string[]): string[] {
  for (const root of new Set(roots)) {
    if (typeof root !== 'string' || !root.trim()) continue;
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch (err) {
      console.warn(
        `[project-home] cannot create writable root ${root}: ${(err as Error).message}`,
      );
    }
  }
  return [...roots];
}

/** 无项目对话的工作区子目录名（与托管项目家目录并列，避免撞名）。 */
export const CHAT_WORKSPACES_DIR = 'conversations';

/**
 * 无项目对话的工作区路径：`Documents/<应用名>/conversations/<chatId>/`。
 * 不落盘；调用方用 {@link ensureChatWorkspace} 创建。
 */
export function chatWorkspacePath(
  chatId: string,
  options?: {
    documentsDir?: string;
    appFolderName?: string;
  },
): string {
  const id = sanitizeProjectDirName(chatId);
  return path.join(appProjectsRoot(options), CHAT_WORKSPACES_DIR, id);
}

/** 确保无项目对话工作区存在，返回绝对路径。 */
export function ensureChatWorkspace(
  chatId: string,
  options?: {
    documentsDir?: string;
    appFolderName?: string;
  },
): string {
  const folderPath = chatWorkspacePath(chatId, options);
  ensureProjectHome(folderPath);
  return folderPath;
}
