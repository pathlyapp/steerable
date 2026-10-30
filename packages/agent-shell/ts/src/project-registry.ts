/**
 * 项目注册表（项目模式）。
 *
 * 项目 = 名字 + 托管家目录 + 可选源文件夹。家目录默认建在
 * `Documents/<应用名>/<项目名>/`（见 project-home.ts）。chat 通过
 * `chat_sessions.project_id` 绑定项目；绑定后文件读写与命令执行被硬限制
 * 在家目录及其子目录内（见 tool-router.ts 的 ToolExecContext.projectRoot）；
 * 源文件夹及其子目录同样可写。
 *
 * 持久化在 userData/agent-projects.json。存储通过 {@link ProjectKvStore}
 * 接口注入：宿主用 json-store 实现，单测用内存实现（与
 * mcp-server-registry.ts 同一模式）。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ProjectRecord {
  id: string;
  /** 用户可见名称（侧边栏分组标题）。 */
  name: string;
  /** 托管家目录（绝对路径）。默认 `Documents/<应用名>/<项目名>/`。 */
  folderPath: string;
  /**
   * 附加源文件夹（已有代码目录）。与家目录一样可读写，范围含各自子目录。
   * 不替代家目录。旧记录没有此字段，读取时按空列表处理。
   */
  sourceFolders?: string[];
  /**
   * W6-5 项目信任门控：项目目录里的 `AGENTS.md` / `CLAUDE.md` 等规则文件
   * 是「项目作者写给 agent 的指令」——打开一个恶意仓库时，一段精心构造的
   * 规则文件就能劫持 agent。因此项目级规则只在 `trusted: true` 时才加载进
   * 模型上下文；默认不信任（安全缺省），用户显式授权后才加载，且可随时撤销。
   * 旧记录没有此字段，读取时按 `false` 处理（见 {@link ProjectRegistry.isTrusted}）。
   */
  trusted?: boolean;
  /**
   * 命令行创建的项目。桌面创建的记录不写该字段。
   * 旧记录没有此字段，读取时忽略。
   */
  origin?: 'cli';
  /**
   * 侧边栏显示顺序，越小越靠前。旧记录没有此字段时按 createdAt 升序。
   * 用户拖拽排序后每个项目都会写上序号；之后新建的项目没有序号，排在已编号项目之后。
   */
  sortOrder?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  folderPath: string;
  sourceFolders?: string[];
  origin?: 'cli';
}

/** 最小 KV 存储接口，避免本模块直接依赖具体存储实现。 */
export interface ProjectKvStore {
  get(key: 'projects'): ProjectRecord[] | undefined;
  set(key: 'projects', value: ProjectRecord[]): void;
  /**
   * Read-modify-write under the projects file lock. Absent in memory stores;
   * the registry then updates in this process only.
   */
  mutate?(
    key: 'projects',
    update: (current: ProjectRecord[]) => ProjectRecord[],
  ): ProjectRecord[];
}

const STORE_KEY = 'projects';

export class ProjectRegistry {
  constructor(private readonly store: ProjectKvStore) {}

  list(): ProjectRecord[] {
    // 拖过序的记录按 sortOrder；没有序号的旧记录仍按创建时间升序，
    // 并且排在已编号项目之后（新建项目因此出现在列表末尾）。
    return [...(this.store.get(STORE_KEY) ?? [])].sort(compareProjects);
  }

  get(idOrName: string): ProjectRecord | null {
    const needle = idOrName.trim().toLowerCase();
    return (
      this.list().find(
        (p) => p.id === idOrName || p.name.toLowerCase() === needle,
      ) ?? null
    );
  }

  create(input: CreateProjectInput): ProjectRecord {
    const name = input.name.trim();
    const folderPath = input.folderPath.trim();
    if (!name) throw new Error('项目名称不能为空');
    if (!folderPath) throw new Error('项目文件夹不能为空');
    let created: ProjectRecord | null = null;
    this.rewrite((projects) => {
      if (projects.some((project) => project.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`已存在同名项目「${name}」`);
      }
      created = buildProject(name, folderPath, input);
      return [...projects, created];
    });
    return created!;
  }

  /**
   * 同名时在名称后加 `-2`、`-3`，与家目录重名的处理一致。
   */
  createUnique(input: CreateProjectInput): ProjectRecord {
    const base = input.name.trim();
    const folderPath = input.folderPath.trim();
    if (!base) throw new Error('项目名称不能为空');
    if (!folderPath) throw new Error('项目文件夹不能为空');
    let created: ProjectRecord | null = null;
    this.rewrite((projects) => {
      const name = uniqueProjectName(projects, base);
      created = buildProject(name, folderPath, input);
      return [...projects, created];
    });
    return created!;
  }

  /**
   * 按真实路径查找。目录已被删除时 `realpath` 失败，改用记录里的原始路径。
   * Windows 上只忽略大小写。
   */
  findByFolder(
    realDir: string,
    realpath: (target: string) => string = fs.realpathSync,
    platform: NodeJS.Platform = process.platform,
  ): ProjectRecord | null {
    const target = canonicalFolder(realDir, realpath, platform);
    if (!target) return null;
    return locateProject(this.list(), target, realpath, platform);
  }

  /**
   * 在同一次读改写里查找或创建。`D` 等于已有项目，或落在某个项目目录之内时复用
   * （取路径最长的那个）；否则以目录名创建，重名加后缀。
   */
  resolveByFolder(
    folderPath: string,
    options?: { origin?: 'cli'; realpath?: (target: string) => string; platform?: NodeJS.Platform },
  ): { project: ProjectRecord; created: boolean } {
    const realpath = options?.realpath ?? fs.realpathSync;
    const platform = options?.platform ?? process.platform;
    const target = canonicalFolder(folderPath, realpath, platform);
    if (!target) throw new Error('项目文件夹不能为空');
    let created = false;
    let chosen: ProjectRecord | null = null;
    this.rewrite((projects) => {
      const existing = locateProject(projects, target, realpath, platform);
      if (existing) {
        chosen = existing;
        return projects;
      }
      const name = uniqueProjectName(projects, pathFor(platform).basename(target) || 'project');
      chosen = buildProject(name, target, { name, folderPath: target, origin: options?.origin });
      created = true;
      return [...projects, chosen];
    });
    return { project: chosen!, created };
  }

  update(
    id: string,
    updates: Partial<CreateProjectInput>,
  ): ProjectRecord {
    let updated: ProjectRecord | null = null;
    this.rewrite((projects) => {
      const idx = projects.findIndex((p) => p.id === id);
      if (idx === -1) throw new Error('项目不存在');
      const current = projects[idx];
      const nextName = updates.name !== undefined ? updates.name.trim() : current.name;
      if (!nextName) throw new Error('项目名称不能为空');
      const nameClash = projects.some(
        (p) => p.id !== id && p.name.toLowerCase() === nextName.toLowerCase(),
      );
      if (nameClash) throw new Error(`已存在同名项目「${nextName}」`);
      const nextFolder =
        updates.folderPath !== undefined
          ? updates.folderPath.trim()
          : current.folderPath;
      if (!nextFolder) throw new Error('项目文件夹不能为空');
      const sourceFolders =
        updates.sourceFolders !== undefined
          ? normalizeSourceFolders(updates.sourceFolders, nextFolder)
          : normalizeSourceFolders(current.sourceFolders, nextFolder);
      const next: ProjectRecord = {
        ...current,
        name: nextName,
        folderPath: nextFolder,
        sourceFolders: sourceFolders.length > 0 ? sourceFolders : undefined,
        updatedAt: new Date().toISOString(),
      };
      updated = next;
      const copy = projects.slice();
      copy[idx] = next;
      return copy;
    });
    return updated!;
  }

  delete(id: string): boolean {
    let removed = false;
    this.rewrite((projects) => {
      const next = projects.filter((p) => p.id !== id);
      removed = next.length !== projects.length;
      return removed ? next : projects;
    });
    return removed;
  }

  /**
   * 按 orderedIds 重排侧边栏。未出现的 id 忽略；名单里没提到的项目
   * 保持相对顺序接在后面。写入连续的 sortOrder，list() 随后按该序号返回。
   */
  reorder(orderedIds: readonly string[]): ProjectRecord[] {
    let stamped: ProjectRecord[] = [];
    this.rewrite((projects) => {
      const current = [...projects].sort(compareProjects);
      const byId = new Map(current.map((project) => [project.id, project]));
      const next: ProjectRecord[] = [];
      const seen = new Set<string>();
      for (const id of orderedIds) {
        const project = byId.get(id);
        if (!project || seen.has(id)) continue;
        seen.add(id);
        next.push(project);
      }
      for (const project of current) {
        if (!seen.has(project.id)) next.push(project);
      }
      stamped = next.map((project, index) => ({
        ...project,
        sortOrder: index,
      }));
      return stamped;
    });
    return stamped;
  }

  /**
   * W6-5: read the trust flag, defaulting absent (legacy) records to
   * `false` — fail-closed, so a project is never trusted unless the user
   * explicitly said so.
   */
  isTrusted(id: string): boolean {
    return this.get(id)?.trusted === true;
  }

  /** W6-5: grant or revoke trust. Returns the updated record. */
  setTrusted(id: string, trusted: boolean): ProjectRecord {
    let updated: ProjectRecord | null = null;
    this.rewrite((projects) => {
      const idx = projects.findIndex((p) => p.id === id);
      if (idx === -1) throw new Error('项目不存在');
      const next: ProjectRecord = {
        ...projects[idx],
        trusted,
        updatedAt: new Date().toISOString(),
      };
      updated = next;
      const copy = projects.slice();
      copy[idx] = next;
      return copy;
    });
    return updated!;
  }

  private rewrite(update: (current: ProjectRecord[]) => ProjectRecord[]): ProjectRecord[] {
    if (this.store.mutate) return this.store.mutate(STORE_KEY, update);
    const next = update([...(this.store.get(STORE_KEY) ?? [])]);
    this.store.set(STORE_KEY, next);
    return next;
  }
}

function compareProjects(a: ProjectRecord, b: ProjectRecord): number {
  const aOrder = finiteSortOrder(a.sortOrder);
  const bOrder = finiteSortOrder(b.sortOrder);
  if (aOrder !== null && bOrder !== null && aOrder !== bOrder) return aOrder - bOrder;
  if ((aOrder !== null) !== (bOrder !== null)) return aOrder !== null ? -1 : 1;
  const byCreated = a.createdAt.localeCompare(b.createdAt);
  if (byCreated !== 0) return byCreated;
  return a.id.localeCompare(b.id);
}

function finiteSortOrder(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeSourceFolders(
  folders: string[] | undefined,
  homePath: string,
): string[] {
  const home = homePath.trim();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of folders ?? []) {
    const folder = raw.trim();
    if (!folder || folder === home || seen.has(folder)) continue;
    seen.add(folder);
    out.push(folder);
  }
  return out;
}

function buildProject(name: string, folderPath: string, input: CreateProjectInput): ProjectRecord {
  const sourceFolders = normalizeSourceFolders(input.sourceFolders, folderPath);
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name,
    folderPath,
    ...(sourceFolders.length > 0 ? { sourceFolders } : {}),
    ...(input.origin === 'cli' ? { origin: 'cli' as const } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function uniqueProjectName(projects: readonly ProjectRecord[], base: string): string {
  const taken = new Set(projects.map((project) => project.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error('无法分配项目名称：重名过多');
}

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function canonicalFolder(
  folderPath: string,
  realpath: (target: string) => string,
  platform: NodeJS.Platform,
): string {
  const absolute = pathFor(platform).resolve(folderPath.trim());
  if (!absolute) return '';
  try {
    return realpath(absolute);
  } catch {
    return absolute;
  }
}

function locateProject(
  projects: readonly ProjectRecord[],
  target: string,
  realpath: (folder: string) => string,
  platform: NodeJS.Platform,
): ProjectRecord | null {
  const platformPath = pathFor(platform);
  const keyed = projects.map((project) => ({
    project,
    key: canonicalFolder(project.folderPath, realpath, platform),
  }));
  const exact = keyed.find((item) => platformPath.relative(item.key, target) === '');
  if (exact) return exact.project;
  const parents = keyed
    .filter((item) => isInsideFolder(item.key, target, platformPath))
    .sort((left, right) => right.key.length - left.key.length);
  return parents[0]?.project ?? null;
}

function isInsideFolder(parent: string, child: string, platformPath: path.PlatformPath): boolean {
  const relative = platformPath.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !platformPath.isAbsolute(relative);
}
