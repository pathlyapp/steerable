import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ProjectRequest {
  cwd: string;
  projectArg?: string;
  cwdArg?: string;
  noProject: boolean;
  home: string;
  platform: NodeJS.Platform;
  /** Windows `%SystemRoot%`. Other platforms ignore it. */
  systemRoot?: string;
  realpath: (target: string) => string;
  isDirectory: (target: string) => boolean;
}

export type ProtectedDir = 'home' | 'root' | 'system';

export type ProjectSpec =
  | { kind: 'none' }
  | { kind: 'bind'; dir: string; explicit: boolean }
  | { kind: 'error'; code: 2; message: string; reason?: 'protected'; protectedKind?: ProtectedDir };

export function resolveProjectRequest(request: ProjectRequest): ProjectSpec {
  const projectArg = blankToUndefined(request.projectArg);
  const cwdArg = blankToUndefined(request.cwdArg);
  if (request.noProject && (projectArg || cwdArg)) {
    return error('`--no-project` 不能与 `--project` 或 `--cwd` 同时使用。');
  }
  if (request.noProject) return { kind: 'none' };

  if (projectArg && cwdArg) {
    const left = canonicalize(projectArg, request);
    const right = canonicalize(cwdArg, request);
    if (left.kind === 'error') return left;
    if (right.kind === 'error') return right;
    if (left.dir !== right.dir) {
      return error(
        `--cwd 与 --project 指向不同目录：${left.dir}、${right.dir}。二者含义相同，请只保留一个。`,
      );
    }
  }

  const explicit = Boolean(projectArg || cwdArg);
  const target = projectArg ?? cwdArg ?? request.cwd;
  const canonical = canonicalize(target, request);
  if (canonical.kind === 'error') return canonical;
  if (!explicit) {
    const kind = protectedKind(canonical.dir, request);
    if (kind) {
      return {
        kind: 'error',
        code: 2,
        reason: 'protected',
        protectedKind: kind,
        message: protectedRunMessage(kind),
      };
    }
  }
  return { kind: 'bind', dir: canonical.dir, explicit };
}

export function shortenProjectPath(folder: string): string {
  const parts = folder.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return folder;
  return `…/${parts.slice(-2).join('/')}`;
}

export function projectStatusLabel(project: { name: string; folderPath: string } | null): string {
  if (!project) return '独立工作区';
  return `项目 ${project.name} · ${shortenProjectPath(project.folderPath)}`;
}

export function protectedRunMessage(kind: ProtectedDir): string {
  return [
    `不会自动把${kindLabel(kind)}绑定为项目：它包含你的全部文件。`,
    '请改用：<product> run --project <目录> "…"',
    '或使用独立工作区：<product> run --no-project "…"',
  ].join('\n');
}

export function protectedTuiMessage(kind: ProtectedDir): string {
  return [
    `不会自动把${kindLabel(kind)}绑定为项目：它包含你的全部文件。`,
    '',
    '请在项目目录里重新启动，或：',
    '  <product> tui --project <目录>',
    '  <product> tui --no-project      使用独立工作区',
  ].join('\n');
}

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function canonicalize(
  target: string,
  request: ProjectRequest,
): { kind: 'ok'; dir: string } | { kind: 'error'; code: 2; message: string } {
  const absolute = pathFor(request.platform).resolve(request.cwd, target);
  let dir: string;
  try {
    dir = request.realpath(absolute);
  } catch {
    return error(`目录不存在：${absolute}`);
  }
  if (!request.isDirectory(dir)) return error(`不是目录：${dir}`);
  return { kind: 'ok', dir };
}

function protectedKind(
  dir: string,
  request: ProjectRequest,
): ProtectedDir | null {
  const platformPath = pathFor(request.platform);
  if (samePath(request.platform, dir, canonicalHome(request))) return 'home';
  if (samePath(request.platform, dir, platformPath.parse(dir).root)) return 'root';
  const system = systemDirs(request.platform, request.systemRoot);
  if (system.some((entry) => samePath(request.platform, entry, dir))) return 'system';
  return null;
}

function canonicalHome(request: ProjectRequest): string {
  const absolute = pathFor(request.platform).resolve(request.home);
  try {
    return request.realpath(absolute);
  } catch {
    return absolute;
  }
}

/** Windows paths that differ only by letter case are the same directory. */
function samePath(platform: NodeJS.Platform, left: string, right: string): boolean {
  if (platform === 'win32') return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function systemDirs(platform: NodeJS.Platform, systemRoot: string | undefined): string[] {
  if (platform === 'darwin') return ['/System', '/usr', '/bin', '/sbin', '/private'];
  if (platform === 'linux') return ['/usr', '/etc', '/bin', '/sbin', '/var'];
  if (platform === 'win32') {
    const root = systemRoot?.trim() || process.env.SystemRoot || 'C:\\Windows';
    return [path.win32.resolve(root)];
  }
  return [];
}

function kindLabel(kind: ProtectedDir): string {
  if (kind === 'home') return '家目录';
  if (kind === 'root') return '根目录';
  return '系统目录';
}

function error(message: string): { kind: 'error'; code: 2; message: string } {
  return { kind: 'error', code: 2, message };
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function defaultProjectFs(): Pick<ProjectRequest, 'realpath' | 'isDirectory' | 'home' | 'platform' | 'systemRoot'> {
  return {
    home: os.homedir(),
    platform: process.platform,
    ...(process.env.SystemRoot ? { systemRoot: process.env.SystemRoot } : {}),
    realpath: (target) => fs.realpathSync(target),
    isDirectory: (target) => {
      try {
        return fs.statSync(target).isDirectory();
      } catch {
        return false;
      }
    },
  };
}
