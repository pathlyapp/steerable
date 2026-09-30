/**
 * 回合产物文件收集（「本轮写了哪些文件」列表）。
 *
 * 六个来源取并集：
 *
 *  1. 工作区扫描（递归）：回合的可写根（项目根 + 场景包工作区，与 exec
 *     沙箱同源）里 mtime/birthtime ≥ 回合开始时间的文件。覆盖脚本/命令
 *     间接写出的产物（如运行脚本生成的文档、报表）——这类路径无法从
 *     工具参数解析。
 *  2. 显式写工具参数：local_write_file / local_edit_file 的 path。覆盖
 *    「完整权限」模式下写到可写根之外的路径（如 ~/Downloads）。
 *  3. exec cwd 浅扫描（仅顶层一层、跳过点文件）：local_exec_shell /
 *     local_run_snippet 的实际工作目录（显式 cwd；缺省按 executor 规则
 *     回落到项目根或 home）。覆盖「脚本在 cwd 落盘」——无项目对话的
 *     exec 默认 cwd 是 home，产物（如 ~/季度报告.pdf）不在任何递归根里。
 *  4. 命令/代码文本里的绝对路径字面量：exec 命令、snippet 代码中出现的
 *     绝对路径（含 ~/ 前缀与引号包裹形式），stat + 时间水位线验证后并入。
 *     覆盖脚本写到与 cwd 无关的任意位置（如 doc.save('/tmp/x/a.pdf')）。
 *  5. 生成工具结果的结构化 artifacts：每项明确给出 path 与
 *     output / preview / intermediate purpose，是交付选择的最高优先级。
 *  6. 最终回复里的文件引用：Codex file citation、Markdown 本地链接和
 *     行内代码路径，作为模型最终确认的交付文件。
 *
 * 来源 3/4 都是「猜候选、靠 stat + mtime/birthtime 水位线证伪」：命令里
 * 提到的既有文件（ls /etc/hosts）时间戳旧、不会被误收；不存在的路径
 * stat 即失败。因此解析不需要可靠——与沙箱围栏「命令内嵌绝对路径无法
 * 可靠解析所以不拦」不同，展示面可以承受启发式，漏报才伤体验。
 *
 * 单趟末次扫描、无基线快照：kind 标签靠 birthtime（macOS/Windows/新版
 * Linux 文件系统可用）；birthtime 不可用时降级为 'modified'，列表本身
 * 的准确性不依赖 birthtime。
 *
 * 扫描是有界 best-effort：忽略依赖/构建缓存目录，深度与遍历条目数有硬顶，
 * 超限直接截断返回已收集部分——产物列表是展示面，永远不该拖垮回合收尾。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRESENT_FILES_TOOL_NAME,
  readPresentedArgs,
  resolvePresentedPath,
  type PresentedFile,
} from '../present-files.js';
import {
  selectDeliverablePaths,
  type ArtifactPurpose,
  type DeliveryEvidence,
  type DeliveryEvidenceSource,
} from './turn-file-selection.js';

export interface TurnFile {
  /** 绝对路径（点击打开直接用）。 */
  path: string;
  /** created = 本轮新建；modified = 已有文件被改动。 */
  kind: 'created' | 'modified';
  /** 字节数（展示用）。 */
  size: number;
  /** 新增行数（展示用，如 +110）。 */
  additions?: number;
  /** 删除行数（展示用，如 -0）。 */
  deletions?: number;
  /** 类别：deliverable = 本轮交付卡片；intermediate = 其余本轮写过的文件。 */
  category?: 'deliverable' | 'intermediate';
  /** 新回合由后端完成分层证据选择；前端不再二次猜测。 */
  selection?: 'resolved';
  /** 成为交付卡片所依据的最高优先级证据。 */
  deliverySource?: DeliveryEvidenceSource | 'inference';
  /** present_files 给出的一行说明（交付卡片副标题）。 */
  description?: string;
}

/** 扫描入参里只需要工具行动的这几个字段（与 router 的 executedActions 行结构对齐）。 */
export interface TurnFileAction {
  tool?: unknown;
  arguments?: unknown;
  result?: unknown;
  success?: unknown;
}

/** 这些目录要么体量巨大（node_modules/target），要么是框架内部状态（.steerable），扫了只有噪音。 */
const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.next',
  '.nuxt',
  '.cache',
  'target',
  '.steerable',
]);

const IGNORED_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

/** 交付物扩展名（最终产物，如电子表格、幻灯片、文档、图片、音视频、独立页面、压缩包）。 */
export const DELIVERABLE_EXTENSIONS = new Set([
  // 表格 / Spreadsheets
  '.xlsx', '.xls', '.csv', '.tsv', '.numbers',
  // 幻灯片 / Presentations
  '.pptx', '.ppt', '.key', // shell-neutral:allow — Office 幻灯片扩展名，不是产品品牌
  // 文档 / Documents
  '.docx', '.doc', '.pdf', '.pages', '.epub', '.rtf',
  // 图像与富媒体 / Images & Media
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.mp4', '.mov', '.mp3',
  // 独立文档输出与压缩包 / Standalone HTML & Archives
  '.html', '.htm', '.zip', '.tar.gz', '.tar', '.7z',
]);

const INTERMEDIATE_DIR_PATTERNS = [
  /(?:^|[\\/])review_work(?:[\\/]|$)/i,
  /(?:^|[\\/])(?:work|temp|tmp|\.temp|\.tmp|scratch)(?:[\\/]|$)/i,
  /(?:^|[\\/])scripts(?:[\\/]|$)/i,
  /(?:^|[\\/])(?:build|dist|\.cache|__pycache__)(?:[\\/]|$)/i,
];

/** 是否为临时文件 / 办公软件锁定文件（如 ~$ 开头的文件名），产物列表中一律排除。 */
export function isIgnoredFileName(name: string): boolean {
  if (IGNORED_FILE_NAMES.has(name)) return true;
  // Office 临时锁定文件（如 ~$ 开头）
  if (name.startsWith('~$')) return true;
  // 临时文件与编辑器交换文件
  if (name.endsWith('.tmp') || name.endsWith('.swp') || name.endsWith('~')) return true;
  return false;
}

/**
 * 按扩展名做的单文件猜测。回合级取舍在 `selectDeliverablePaths`：
 * 同名预览不会因为扩展名就和正文一起升成卡片。
 */
export function classifyFileCategory(filePath: string): 'deliverable' | 'intermediate' {
  const normalized = filePath.replace(/\\/g, '/');
  const ext = path.extname(normalized).toLowerCase();
  // 1. 若具有最终交付产物扩展名（电子表格、PPT、PDF、图片等），属于交付物
  if (DELIVERABLE_EXTENSIONS.has(ext)) return 'deliverable';
  // 2. 位于中间工作目录（如 review_work/、scripts/）属于中间文件
  for (const pattern of INTERMEDIATE_DIR_PATTERNS) {
    if (pattern.test(normalized)) return 'intermediate';
  }
  // 3. 其余脚本、代码、配置文件均归为中间文件
  return 'intermediate';
}

/** 从统一 diff 文本中统计增删行数。 */
export function parseDiffStats(diffText: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

/** 单次扫描的遍历上限：深度 10、条目 10 万、结果 100 条。 */
const MAX_DEPTH = 10;
const MAX_VISITED = 100_000;
const MAX_FILES = 100;

/** 显式写工具：参数里的 path 并入产物列表（覆盖可写根之外的写入）。 */
const WRITE_TOOL_NAMES = new Set(['local_write_file', 'local_edit_file']);

/** exec 类工具：cwd 浅扫描与命令文本路径字面量的来源。 */
const EXEC_TOOL_NAMES = new Set(['local_exec_shell', 'local_run_snippet']);

/** 每条命令/代码文本最多提取的路径字面量个数（防超长命令刷 stat）。 */
const MAX_PATH_LITERALS_PER_ACTION = 50;

/**
 * Linux overlay/tmpfs 常把 mtime/birthtime 截到 1s。回合开始后立刻写出的
 * 产物会 stat 成略早于 sinceMs，被水位线丢掉。1s 容差远小于一轮对话，
 * 只影响展示列表，允许把回合前 1s 内的文件算进来。
 */
const TOUCHED_SLACK_MS = 1000;

/**
 * 引号包裹的绝对路径字面量：python 代码里的 doc.save('/x/a.pdf')、shell
 * 里的 "/x/a.pdf"。要求以 /、~/ 或 Windows 盘符开头、带扩展名结尾。
 * 贪婪匹配到闭引号再回溯到最后一个点——目录名里带点（.venv/python3.11）
 * 不会把路径截断在中间。
 */
const QUOTED_PATH_PATTERN = /['"]((?:~\/|\/|[A-Za-z]:[\\/])[^'"]{1,300}\.[A-Za-z0-9]{1,10})['"]/g;

/**
 * 裸绝对路径字面量（无引号、无空格）：shell 重定向/参数里常见的写法。
 * 排除引号/空白/shell 元字符；URL 的 // 开头被 (?!\/) 挡掉；同样贪婪到
 * token 尾再回溯到最后一个点，(?![A-Za-z0-9]) 保证扩展名不被截断。
 */
const BARE_PATH_PATTERN =
  /(?:~\/|\/(?!\/))[^\s"'`<>|;,()[\]{}\\*?]{1,300}\.[A-Za-z0-9]{1,10}(?![A-Za-z0-9])|[A-Za-z]:\\[^\s"'`<>|;,*?]{1,300}\.[A-Za-z0-9]{1,10}(?![A-Za-z0-9])/g;

/**
 * 收集本轮产物文件。`sinceMs` 是回合开始的 epoch ms；`projectRoot` 用于把
 * 写工具的相对路径参数解析成绝对路径（与 local-executor 的项目根解析一致）。
 * `homeDir` 仅测试注入用，默认 os.homedir()——exec 缺省 cwd 的回落值。
 */
export async function collectTurnFiles(options: {
  roots: string[];
  sinceMs: number;
  actions?: readonly TurnFileAction[];
  projectRoot?: string | null;
  homeDir?: string;
  /** 完整助手回复；其中明确的本地文件链接或行内代码路径属于最终引用。 */
  finalText?: string;
}): Promise<TurnFile[]> {
  const { roots, sinceMs, projectRoot = null } = options;
  const homeDir = options.homeDir ?? os.homedir();
  const byPath = new Map<string, TurnFile>();

  for (const root of roots) {
    await scanRoot(root, sinceMs, byPath);
  }
  const shallowRoots = new Set<string>();
  for (const action of options.actions ?? []) {
    await collectWriteToolPath(action, sinceMs, projectRoot, byPath);
    const cwd = execCwdOf(action, projectRoot, homeDir);
    if (cwd && !isCoveredByRoots(cwd, roots)) shallowRoots.add(cwd);
    await collectPathLiterals(action, sinceMs, homeDir, byPath);
  }
  for (const dir of shallowRoots) {
    await scanShallow(dir, sinceMs, byPath);
  }

  // present_files 声明的文件：本轮可能没动过（交付已有文件），不受时间水位线
  // 约束，只要求仍是普通文件。路径按 realpath + NFC 并到扫描结果上，避免
  // macOS 文件名归一化或 /var 与 /private/var 把同一文件收成两条。
  const presentedByKey = new Map<string, PresentedFile>();
  for (const action of options.actions ?? []) {
    if (action.tool !== PRESENT_FILES_TOOL_NAME || action.success === false) continue;
    for (const file of readPresentedArgs(action.arguments, projectRoot, homeDir)) {
      const key = await canonicalFileKey(file.path);
      const prev = presentedByKey.get(key);
      if (!prev || (!prev.description && file.description)) presentedByKey.set(key, file);
    }
  }
  for (const [key, file] of presentedByKey) {
    if (byPath.has(key)) continue;
    const stat = await statPresentedFile(file.path);
    if (stat) byPath.set(key, stat);
  }

  // 生成工具可在成功结果的 artifacts 数组里直接声明 path + purpose。
  // 这是最高优先级来源，不用文件名猜主文件与预览文件。
  const generatedByKey = new Map<string, StructuredArtifact>();
  for (const action of options.actions ?? []) {
    if (action.success === false) continue;
    for (const artifact of readStructuredArtifacts(action.result, projectRoot, homeDir)) {
      const key = await canonicalFileKey(artifact.path);
      generatedByKey.set(key, artifact);
      if (byPath.has(key)) continue;
      const stat = await statPresentedFile(artifact.path);
      if (stat) byPath.set(key, stat);
    }
  }

  // 最终回复中的 Codex file citation、Markdown 本地链接和行内代码路径是次高
  // 优先级。它们也可以引用本轮没改过但交付给用户的已有文件。
  const finalReferencesByKey = new Map<string, FinalFileReference>();
  for (const reference of readFinalFileReferences(
    options.finalText ?? '',
    projectRoot,
    homeDir,
  )) {
    const key = await canonicalFileKey(reference.path);
    const previous = finalReferencesByKey.get(key);
    if (!previous || reference.explicitOutput) finalReferencesByKey.set(key, reference);
    if (byPath.has(key)) continue;
    const stat = await statPresentedFile(reference.path);
    if (stat) byPath.set(key, stat);
  }

  // 从 actions 中提取增删行数统计（local_edit_file 的 diff 或 local_write_file 的 content）
  const statsByPath = new Map<string, { additions: number; deletions: number }>();
  for (const action of options.actions ?? []) {
    if (typeof action.tool === 'string') {
      const args = action.arguments && typeof action.arguments === 'object' ? (action.arguments as Record<string, unknown>) : null;
      const rawPath = typeof args?.path === 'string' ? args.path : null;
      if (rawPath) {
        const full = path.isAbsolute(rawPath)
          ? path.normalize(rawPath)
          : projectRoot
            ? path.resolve(projectRoot, rawPath)
            : null;
        if (full) {
          if (action.tool === 'local_edit_file') {
            const diff = editDiffOf(action.result);
            if (diff !== null) {
              const diffStats = parseDiffStats(diff);
              const prev = statsByPath.get(full) ?? { additions: 0, deletions: 0 };
              statsByPath.set(full, {
                additions: prev.additions + diffStats.additions,
                deletions: prev.deletions + diffStats.deletions,
              });
            }
          } else if (action.tool === 'local_write_file') {
            if (typeof args?.content === 'string') {
              const lineCount = args.content ? args.content.split('\n').length : 0;
              statsByPath.set(full, { additions: lineCount, deletions: 0 });
            }
          }
        }
      }
    }
  }

  const visible: Array<{ key: string; file: TurnFile }> = [];
  for (const [key, file] of byPath) {
    if (isIgnoredFileName(path.basename(file.path))) continue;
    visible.push({ key, file });
  }
  const evidence: DeliveryEvidence[] = [];
  for (const { key, file } of visible) {
    const generated = generatedByKey.get(key);
    if (generated) {
      evidence.push({
        path: file.path,
        source: 'generation',
        purpose: generated.purpose,
      });
    }
    const finalReference = finalReferencesByKey.get(key);
    if (finalReference) {
      evidence.push({
        path: file.path,
        source: 'final-reference',
        ...(finalReference.explicitOutput ? { purpose: 'output' } : {}),
      });
    }
    const presented = presentedByKey.get(key);
    if (presented) {
      evidence.push({
        path: file.path,
        source: 'present-files',
        ...(presented.purpose ? { purpose: presented.purpose } : {}),
      });
    }
  }
  const deliverablePaths = selectDeliverablePaths(
    visible.map(({ file }) => file),
    evidence,
  );

  const enriched: TurnFile[] = [];
  for (const { key, file } of visible) {
    const stats = statsByPath.get(file.path);
    const declared = presentedByKey.get(key);
    const generated = generatedByKey.get(key);
    const category = deliverablePaths.has(file.path) ? 'deliverable' : 'intermediate';
    const deliverySource =
      category === 'deliverable'
        ? selectedDeliverySource(key, generatedByKey, finalReferencesByKey, presentedByKey)
        : undefined;
    enriched.push({
      ...file,
      category,
      selection: 'resolved',
      ...(deliverySource ? { deliverySource } : {}),
      // 预览被拿掉之后，不把它的说明贴到推断出的可编辑文件上。
      ...(category === 'deliverable' && (generated?.description || declared?.description)
        ? { description: generated?.description ?? declared?.description }
        : {}),
      ...(stats ? { additions: stats.additions, deletions: stats.deletions } : {}),
    });
  }

  return enriched
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, MAX_FILES);
}

async function scanRoot(
  root: string,
  sinceMs: number,
  out: Map<string, TurnFile>,
): Promise<void> {
  const state = { visited: 0 };
  await walk(path.resolve(root), sinceMs, 0, state, out);
}

interface WalkState {
  visited: number;
}

async function walk(
  dir: string,
  sinceMs: number,
  depth: number,
  state: WalkState,
  out: Map<string, TurnFile>,
): Promise<void> {
  if (depth > MAX_DEPTH || state.visited >= MAX_VISITED) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // 根目录被删/无权限：跳过该根，不影响其他根。
    return;
  }
  for (const entry of entries) {
    if (state.visited >= MAX_VISITED) return;
    state.visited += 1;
    const full = path.join(dir, entry.name);
    // 不跟随符号链接：避免链接环把扫描拖出根外。
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (IGNORED_DIR_NAMES.has(entry.name)) continue;
      await walk(full, sinceMs, depth + 1, state, out);
      continue;
    }
    if (!entry.isFile() || isIgnoredFileName(entry.name)) continue;
    const file = await statTurnFile(full, sinceMs);
    if (file) await putTurnFile(out, file);
  }
}

/** 同一文件的扫描路径和模型声明路径收成一个键。 */
async function canonicalFileKey(filePath: string): Promise<string> {
  try {
    return (await fs.realpath(filePath)).normalize('NFC');
  } catch {
    return path.normalize(filePath).normalize('NFC');
  }
}

async function putTurnFile(out: Map<string, TurnFile>, file: TurnFile): Promise<void> {
  const key = await canonicalFileKey(file.path);
  if (!out.has(key)) out.set(key, file);
}

/** stat 一个文件，命中「本轮触碰过」则返回 TurnFile，否则 null。 */
async function statTurnFile(full: string, sinceMs: number): Promise<TurnFile | null> {
  let stat;
  try {
    stat = await fs.stat(full);
  } catch {
    // 扫描窗口内被删掉的文件直接略过。
    return null;
  }
  // 路径字面量可能指到目录（如 xxx.app 包）；产物列表只收文件。
  if (!stat.isFile() || isIgnoredFileName(path.basename(full))) return null;
  const touched =
    stat.mtimeMs + TOUCHED_SLACK_MS >= sinceMs ||
    stat.birthtimeMs + TOUCHED_SLACK_MS >= sinceMs;
  if (!touched) return null;
  return { path: full, kind: kindOf(stat, sinceMs), size: stat.size };
}

/** 声明的交付文件只要求仍是普通文件；本轮没动过的已有文件标 modified。 */
async function statPresentedFile(full: string): Promise<TurnFile | null> {
  let stat;
  try {
    stat = await fs.stat(full);
  } catch {
    // 声明后到回合收尾之间被删掉：不再列出。
    return null;
  }
  if (!stat.isFile()) return null;
  return { path: full, kind: 'modified', size: stat.size };
}

interface StructuredArtifact {
  path: string;
  purpose: ArtifactPurpose;
  description?: string;
}

/**
 * 生成工具结果的标准产物字段：
 * `{ artifacts: [{ path, purpose, description? }] }`，sidecar 包装结果也可放在
 * `data.artifacts`。purpose 必填，避免把没有语义的路径数组冒充可靠证据。
 */
function readStructuredArtifacts(
  result: unknown,
  projectRoot: string | null,
  homeDir: string,
): StructuredArtifact[] {
  if (!result || typeof result !== 'object') return [];
  const record = result as Record<string, unknown>;
  const data =
    record.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : null;
  const raw = Array.isArray(record.artifacts)
    ? record.artifacts
    : Array.isArray(data?.artifacts)
      ? data.artifacts
      : [];
  const artifacts: StructuredArtifact[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const artifact = item as Record<string, unknown>;
    if (typeof artifact.path !== 'string' || !isArtifactPurpose(artifact.purpose)) continue;
    const resolved = resolvePresentedPath(artifact.path, projectRoot, homeDir);
    if (!resolved) continue;
    const description =
      typeof artifact.description === 'string' ? artifact.description.trim() : '';
    artifacts.push({
      path: resolved,
      purpose: artifact.purpose,
      ...(description ? { description } : {}),
    });
  }
  return artifacts;
}

function isArtifactPurpose(value: unknown): value is ArtifactPurpose {
  return value === 'output' || value === 'preview' || value === 'intermediate';
}

interface FinalFileReference {
  path: string;
  explicitOutput: boolean;
}

function readFinalFileReferences(
  text: string,
  projectRoot: string | null,
  homeDir: string,
): FinalFileReference[] {
  if (!text) return [];
  const rawPaths = new Map<string, boolean>();

  for (const match of text.matchAll(/:codex-file-citation\{([^}]*)\}/g)) {
    const attributes = match[1] ?? '';
    const purpose = directiveAttribute(attributes, 'purpose');
    const filePath = directiveAttribute(attributes, 'path');
    if (purpose === 'output' && filePath) rawPaths.set(filePath, true);
  }

  for (const match of text.matchAll(/!?\[[^\]]*]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g)) {
    const target = match[1] ?? match[2];
    if (target && !rawPaths.has(target)) rawPaths.set(target, false);
  }

  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const candidate = match[1]?.trim();
    if (candidate && looksLikeLocalFileReference(candidate) && !rawPaths.has(candidate)) {
      rawPaths.set(candidate, false);
    }
  }

  const resolved = new Map<string, FinalFileReference>();
  for (const [raw, explicitOutput] of rawPaths) {
    const decoded = decodeFileReference(raw);
    if (!decoded || /^(?:https?|data):/i.test(decoded)) continue;
    const filePath = resolvePresentedPath(decoded, projectRoot, homeDir);
    if (!filePath) continue;
    const previous = resolved.get(filePath);
    if (!previous || explicitOutput) {
      resolved.set(filePath, { path: filePath, explicitOutput });
    }
  }
  return [...resolved.values()];
}

function directiveAttribute(attributes: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\s)${escaped}=(?:"([^"]*)"|'([^']*)'|([^\\s}]+))`).exec(
    attributes,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function decodeFileReference(raw: string): string | null {
  let value = raw.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    // 非法百分号不是可靠的文件引用。
    return null;
  }
  if (value.startsWith('file://')) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }
  return value;
}

function looksLikeLocalFileReference(value: string): boolean {
  if (/^(?:~\/|\/|[A-Za-z]:[\\/])/.test(value)) return path.extname(value).length > 1;
  return (
    !/^[a-z][a-z0-9+.-]*:/i.test(value) &&
    /(?:^|[/\\])[^/\\]+\.[A-Za-z0-9]{1,10}$/.test(value)
  );
}

function selectedDeliverySource(
  key: string,
  generatedByKey: ReadonlyMap<string, StructuredArtifact>,
  finalReferencesByKey: ReadonlyMap<string, FinalFileReference>,
  presentedByKey: ReadonlyMap<string, PresentedFile>,
): DeliveryEvidenceSource | 'inference' {
  const generated = generatedByKey.get(key);
  if (generated?.purpose === 'output') return 'generation';
  if (generated?.purpose === 'preview' || generated?.purpose === 'intermediate') {
    return 'inference';
  }
  if (finalReferencesByKey.has(key)) return 'final-reference';
  if (presentedByKey.has(key)) return 'present-files';
  return 'inference';
}

/** local_edit_file 的 diff：直连结果在顶层，经 sidecar 回流的结果折进 `data`。 */
function editDiffOf(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  if (typeof record.diff === 'string') return record.diff;
  const data = record.data;
  if (data && typeof data === 'object' && typeof (data as Record<string, unknown>).diff === 'string') {
    return (data as Record<string, unknown>).diff as string;
  }
  return null;
}

function kindOf(stat: { mtimeMs: number; birthtimeMs: number }, sinceMs: number): 'created' | 'modified' {
  // birthtime 不可用的文件系统返回 0/负值——此时无法区分新建与修改，
  // 统一标 modified（标签降级，不漏文件）。
  return stat.birthtimeMs >= sinceMs ? 'created' : 'modified';
}

async function collectWriteToolPath(
  action: TurnFileAction,
  sinceMs: number,
  projectRoot: string | null,
  out: Map<string, TurnFile>,
): Promise<void> {
  if (typeof action.tool !== 'string' || !WRITE_TOOL_NAMES.has(action.tool)) return;
  // success === false 的调用没写成；undefined（流中未落定）按成功处理——
  // 文件是否真存在由下面的 stat 把关。
  if (action.success === false) return;
  const args = action.arguments;
  if (!args || typeof args !== 'object') return;
  const raw = (args as Record<string, unknown>).path;
  if (typeof raw !== 'string' || !raw.trim()) return;
  const full = path.isAbsolute(raw)
    ? path.normalize(raw)
    : projectRoot
      ? path.resolve(projectRoot, raw)
      : null;
  if (!full || out.has(await canonicalFileKey(full))) return;
  const file = await statTurnFile(full, sinceMs);
  if (file) await putTurnFile(out, file);
}

/**
 * exec 行动的实际工作目录（与 tool-router / local-executor 的解析规则对齐）：
 * 显式 cwd 展开 ~ 后按绝对/相对解析（相对在项目模式下按项目根、否则按
 * 进程 cwd）；缺省 cwd 回落到项目根，无项目时回落到 home——无项目对话里
 * 脚本产物最常见的落点。
 */
function execCwdOf(
  action: TurnFileAction,
  projectRoot: string | null,
  homeDir: string,
): string | null {
  if (typeof action.tool !== 'string' || !EXEC_TOOL_NAMES.has(action.tool)) return null;
  const args = action.arguments;
  if (!args || typeof args !== 'object') return null;
  const raw = (args as Record<string, unknown>).cwd;
  const cwdArg = typeof raw === 'string' ? raw.trim() : '';
  if (!cwdArg) return projectRoot ?? homeDir;
  const expanded = cwdArg.startsWith('~') ? path.join(homeDir, cwdArg.slice(1)) : cwdArg;
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return projectRoot ? path.resolve(projectRoot, expanded) : path.resolve(expanded);
}

/** cwd 已落在某个递归根之内时无需再浅扫（递归扫描已覆盖且更深）。 */
function isCoveredByRoots(cwd: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(path.resolve(root), cwd);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/**
 * exec cwd 的浅扫描：只看顶层一层、跳过点文件。home 顶层的变化几乎全是
 * 工具状态（.zsh_history 之类），点文件过滤掉它们；真正的产物文档极少
 * 以点开头。浅扫不递归——home 这种根递归起来既慢又全是无关变化。
 */
async function scanShallow(
  dir: string,
  sinceMs: number,
  out: Map<string, TurnFile>,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // cwd 被删/无权限：跳过，不影响其他来源。
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || isIgnoredFileName(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    if (out.has(await canonicalFileKey(full))) continue;
    const file = await statTurnFile(full, sinceMs);
    if (file) await putTurnFile(out, file);
  }
}

/**
 * 从 exec 命令 / snippet 代码文本里提取绝对路径字面量，stat + 水位线
 * 验证后并入。覆盖脚本写到与 cwd 无关的任意位置。local_run_script 的
 * 脚本内容在注册表里、行动参数只有 scriptId，不在此覆盖（其 cwd 语义
 * 与 exec_shell 相同，浅扫描已兜底常见落点）。
 */
async function collectPathLiterals(
  action: TurnFileAction,
  sinceMs: number,
  homeDir: string,
  out: Map<string, TurnFile>,
): Promise<void> {
  if (typeof action.tool !== 'string' || !EXEC_TOOL_NAMES.has(action.tool)) return;
  const args = action.arguments;
  if (!args || typeof args !== 'object') return;
  const record = args as Record<string, unknown>;
  const text = [record.command, record.code]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  if (!text) return;

  const candidates = new Set<string>();
  for (const pattern of [QUOTED_PATH_PATTERN, BARE_PATH_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (candidates.size >= MAX_PATH_LITERALS_PER_ACTION) break;
      const literal = match[1] ?? match[0];
      const expanded = literal.startsWith('~/')
        ? path.join(homeDir, literal.slice(2))
        : literal;
      candidates.add(path.normalize(expanded));
    }
  }
  for (const full of candidates) {
    if (out.has(await canonicalFileKey(full))) continue;
    const file = await statTurnFile(full, sinceMs);
    if (file) await putTurnFile(out, file);
  }
}
