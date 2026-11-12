/**
 * 把产品命令行包装脚本写进用户 PATH 里一个可写的目录。
 * 桌面安装包里的入口是 products/<bin>/cli.js；仓库里优先用 cli.mjs。
 */

import { accessSync, chmodSync, constants, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { getAppRootDir } from './runtime.js';

export interface CliInstallResult {
  path: string;
  onPath: boolean;
}

export interface CliInstallLinkInput {
  binName: string;
  scriptPath: string;
  nodePath: string;
  home: string;
  pathEnv: string;
  platform: NodeJS.Platform;
  exists(target: string): boolean;
  canWrite(dir: string): boolean;
  mkdir(dir: string): void;
  writeFile(file: string, contents: string): void;
  chmod(file: string, mode: number): void;
}

/** 在应用根下找命令行入口。 */
export function resolveCliScript(
  appRoot: string,
  binName: string,
  exists: (target: string) => boolean,
): string | null {
  const candidates = [
    path.join(appRoot, 'products', binName, 'cli.mjs'),
    path.join(appRoot, 'products', binName, 'cli.js'),
    path.join(appRoot, 'dist', 'products', binName, 'cli.js'),
  ];
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** 写包装脚本。目录选用户主目录下、已经在 PATH 里、并且可写的那个。 */
export function installCliLink(input: CliInstallLinkInput): CliInstallResult {
  if (input.binName.includes('/') || input.binName.includes('\\')) {
    throw new Error(`command name "${input.binName}" cannot contain a path separator`);
  }
  const pathApi = input.platform === 'win32' ? path.win32 : path.posix;
  const delimiter = input.platform === 'win32' ? ';' : ':';
  const pathDirs = input.pathEnv.split(delimiter).filter((dir) => dir.length > 0);
  const preferred = [
    pathApi.join(input.home, '.local', 'bin'),
    pathApi.join(input.home, 'bin'),
  ];
  const ordered: { dir: string; onPath: boolean }[] = [];
  const seen = new Set<string>();
  const push = (dir: string, onPath: boolean) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    ordered.push({ dir, onPath });
  };
  for (const dir of preferred) {
    if (pathDirs.includes(dir)) push(dir, true);
  }
  for (const dir of pathDirs) {
    if (dir === input.home || dir.startsWith(input.home + pathApi.sep)) push(dir, true);
  }
  push(preferred[0], pathDirs.includes(preferred[0]));
  const chosen = ordered.find((entry) => input.canWrite(entry.dir));
  if (!chosen) {
    throw new Error('no writable directory on PATH under the home directory');
  }
  if (!input.exists(chosen.dir)) input.mkdir(chosen.dir);
  const fileName = input.platform === 'win32' ? `${input.binName}.cmd` : input.binName;
  const file = pathApi.join(chosen.dir, fileName);
  const contents = input.platform === 'win32'
    ? `@echo off\r\n${quoteCmd(input.nodePath)} ${quoteCmd(input.scriptPath)} %*\r\n`
    : `#!/bin/sh\nexec ${quoteShell(input.nodePath)} ${quoteShell(input.scriptPath)} "$@"\n`;
  input.writeFile(file, contents);
  if (input.platform !== 'win32') input.chmod(file, 0o755);
  return { path: file, onPath: chosen.onPath };
}

/** 把名为 `binName` 的产品命令安装到 PATH。调用方传入命令名。 */
export function installProductCli(binName: string): CliInstallResult {
  const name = binName.trim();
  if (!name) throw new Error('This product has no command-line name.');
  const scriptPath = resolveCliScript(getAppRootDir(), name, existsSync);
  if (!scriptPath) throw new Error('The command-line tool is not included in this installation.');
  return installCliLink({
    binName: name,
    scriptPath,
    nodePath: process.execPath,
    home: homedir(),
    pathEnv: process.env.PATH ?? '',
    platform: process.platform,
    exists: existsSync,
    canWrite: canWriteDir,
    mkdir: (dir) => mkdirSync(dir, { recursive: true }),
    writeFile: (file, contents) => writeFileSync(file, contents, 'utf8'),
    chmod: (file, mode) => chmodSync(file, mode),
  });
}

function canWriteDir(dir: string): boolean {
  try {
    if (existsSync(dir)) {
      accessSync(dir, constants.W_OK);
      return true;
    }
    accessSync(path.dirname(dir), constants.W_OK);
    return true;
  } catch (error) {
    // 目录或其父目录不可写。
    void error;
    return false;
  }
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteCmd(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
