/**
 * 回合产物文件列表（「本轮写了哪些文件」）的前端模型。
 *
 * 数据源：local-backend 在回合收尾时扫描可写根 + 写工具参数并集（见
 * `src/local-backend/turn-files.ts`），经 `turn_files` SSE 事件下发，并
 * 持久化进助手消息的 messageMetadata（键 `turnFiles`）供刷新后水合。
 */

export interface TurnFile {
  /** 绝对路径 —— 点击打开直接传给后端。 */
  path: string;
  /** created = 本轮新建；modified = 已有文件被改动。 */
  kind: 'created' | 'modified';
  /** 字节数（展示用，可缺省）。 */
  size?: number;
  /** 新增行数（展示用，如 +110）。 */
  additions?: number;
  /** 删除行数（展示用，如 -0）。 */
  deletions?: number;
  /** 类别：deliverable = 本轮交付卡片；intermediate = 其余本轮写过的文件。 */
  category?: 'deliverable' | 'intermediate';
  /** 后端已经按分层证据完成选择；前端必须原样采用 category。 */
  selection?: 'resolved';
  /** 交付选择的来源，供调试和后续展示使用。 */
  deliverySource?: 'generation' | 'final-reference' | 'present-files' | 'inference';
  /** present_files 给出的一行说明（交付卡片副标题）。 */
  description?: string;
}

/** 解析 SSE 事件 / 持久化元数据里的文件列表；形状不符返回 null（与 parseTurnBlocks 同约定）。 */
export function parseTurnFiles(raw: unknown): TurnFile[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const files: TurnFile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const rec = item as Record<string, unknown>;
    if (typeof rec.path !== 'string' || !rec.path) return null;
    if (rec.kind !== 'created' && rec.kind !== 'modified') return null;
    files.push({
      path: rec.path,
      kind: rec.kind,
      ...(typeof rec.size === 'number' ? { size: rec.size } : {}),
      ...(typeof rec.additions === 'number' ? { additions: rec.additions } : {}),
      ...(typeof rec.deletions === 'number' ? { deletions: rec.deletions } : {}),
      ...(rec.category === 'deliverable' || rec.category === 'intermediate'
        ? { category: rec.category }
        : {}),
      ...(rec.selection === 'resolved' ? { selection: rec.selection } : {}),
      ...(rec.deliverySource === 'generation' ||
      rec.deliverySource === 'final-reference' ||
      rec.deliverySource === 'present-files' ||
      rec.deliverySource === 'inference'
        ? { deliverySource: rec.deliverySource }
        : {}),
      ...(typeof rec.description === 'string' && rec.description
        ? { description: rec.description }
        : {}),
    });
  }
  return files;
}

/** 文件名的展示分段：basename 加粗、目录部分弱化。 */
export function splitTurnFilePath(filePath: string): { dir: string; name: string } {
  const normalized = filePath.replace(/[/\\]+$/, '');
  const idx = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (idx < 0) return { dir: '', name: normalized };
  return { dir: normalized.slice(0, idx + 1), name: normalized.slice(idx + 1) };
}

/** 获取小写扩展名（含前导点）。 */
export function getFileExtension(filePath: string): string {
  const normalized = filePath.replace(/[/\\]+$/, '');
  const lastDot = normalized.lastIndexOf('.');
  const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (lastDot > lastSlash && lastDot >= 0) {
    return normalized.slice(lastDot).toLowerCase();
  }
  return '';
}

/** 紧凑的字节数展示（不足 1 KB 显示 B）。 */
export function formatFileSize(size: number | undefined): string | null {
  if (size == null || !Number.isFinite(size) || size < 0) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** 是否为临时文件 / Office 锁定文件（如 ~$ 开头的文件名），产物列表中一律排除。 */
export function isIgnoredTurnFile(filePath: string): boolean {
  const { name } = splitTurnFilePath(filePath);
  if (!name) return true;
  if (name === '.DS_Store' || name === 'Thumbs.db') return true;
  // Office 临时锁定文件
  if (name.startsWith('~$')) return true;
  // 临时文件与编辑器交换文件
  if (name.endsWith('.tmp') || name.endsWith('.swp') || name.endsWith('~')) return true;
  return false;
}

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

/**
 * 单文件扩展名猜测。回合里有多份文件时，`groupTurnFiles` 会再拿掉同名预览。
 * 没有 category 的是声明机制上线前落库的消息。
 */
export function getTurnFileCategory(file: TurnFile): 'deliverable' | 'intermediate' {
  if (file.category) return file.category;
  const ext = getFileExtension(file.path);
  if (DELIVERABLE_EXTENSIONS.has(ext)) return 'deliverable';
  return 'intermediate';
}

export type DeliverableFileKind =
  | 'spreadsheet'
  | 'presentation'
  | 'document'
  | 'pdf'
  | 'image'
  | 'archive'
  | 'code'
  | 'file';

export interface DeliverableFileMeta {
  label: string;
  extBadge: string;
  kind: DeliverableFileKind;
  themeColor: 'emerald' | 'amber' | 'blue' | 'rose' | 'purple' | 'slate';
}

export function getDeliverableMeta(filePath: string): DeliverableFileMeta {
  const ext = getFileExtension(filePath);
  const extClean = ext.replace(/^\./, '').toUpperCase() || 'FILE';

  switch (ext) {
    case '.xlsx':
    case '.xls':
    case '.csv':
    case '.tsv':
    case '.numbers':
      return {
        label: 'Spreadsheet',
        extBadge: extClean,
        kind: 'spreadsheet',
        themeColor: 'emerald',
      };
    case '.pptx': // shell-neutral:allow — Office 幻灯片扩展名，不是产品品牌
    case '.ppt': // shell-neutral:allow — Office 幻灯片扩展名，不是产品品牌
    case '.key':
      return {
        label: 'Presentation',
        extBadge: extClean,
        kind: 'presentation',
        themeColor: 'amber',
      };
    case '.docx':
    case '.doc':
    case '.pages':
    case '.rtf':
      return {
        label: 'Document',
        extBadge: extClean,
        kind: 'document',
        themeColor: 'blue',
      };
    case '.pdf':
      return {
        label: 'Document',
        extBadge: 'PDF',
        kind: 'pdf',
        themeColor: 'rose',
      };
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.webp':
    case '.svg':
      return {
        label: 'Image',
        extBadge: extClean,
        kind: 'image',
        themeColor: 'purple',
      };
    case '.zip':
    case '.tar':
    case '.gz':
    case '.7z':
      return {
        label: 'Archive',
        extBadge: extClean,
        kind: 'archive',
        themeColor: 'amber',
      };
    case '.html':
    case '.htm':
      return {
        label: 'Web page',
        extBadge: 'HTML',
        kind: 'document',
        themeColor: 'blue',
      };
    default:
      return {
        label: 'File',
        extBadge: extClean,
        kind: 'file',
        themeColor: 'slate',
      };
  }
}

/** 规范化展示路径（若在特定项目/脚本目录下，提取便于阅读的相对路径）。 */
export function formatIntermediateDisplayPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const markers = ['/review_work/', '/src/', '/scripts/', '/packages/', '/work/', '/tests/'];
  for (const marker of markers) {
    const idx = normalized.indexOf(marker);
    if (idx >= 0) {
      return normalized.slice(idx + 1);
    }
  }
  const { dir, name } = splitTurnFilePath(filePath);
  if (!dir) return name;
  const parts = dir.replace(/\/$/, '').split(/[/\\]/);
  const lastFolder = parts[parts.length - 1];
  return lastFolder ? `${lastFolder}/${name}` : name;
}

export interface GroupedTurnFiles {
  deliverables: TurnFile[];
  intermediates: TurnFile[];
  totalAdditions: number;
  totalDeletions: number;
}

/** 从 unified diff 解析增删行数。 */
function parseDiffStats(diffText: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

const SOURCE_EXTENSIONS = new Set([
  '.pptx', '.ppt', '.key', // shell-neutral:allow — Office 幻灯片扩展名，不是产品品牌
  '.docx', '.doc', '.pages',
  '.xlsx', '.xls', '.xlsm', '.numbers',
]);

const PREVIEW_NAME = /预览|截图|图像版|preview|screenshot|thumbnail/i;

/**
 * 旧消息没有 selection=resolved，只纠正最明确的一种历史误判：同目录的
 * 幻灯片与预览 PDF / 截图都被标成交付物。新消息完全采用后端结论。
 */
function selectLegacyDeliverablePaths(files: readonly TurnFile[]): Set<string> {
  const chosen = new Set(
    files.filter((file) => getTurnFileCategory(file) === 'deliverable').map((file) => file.path),
  );
  const sources = files
    .filter((file) => SOURCE_EXTENSIONS.has(getFileExtension(file.path)))
    .map((file) => file.path);
  for (const candidate of [...chosen]) {
    const source = sources.find((item) => isLegacyPreviewOf(candidate, item));
    if (!source) continue;
    chosen.delete(candidate);
    chosen.add(source);
  }
  return new Set(chosen);
}

function isLegacyPreviewOf(filePath: string, sourcePath: string): boolean {
  if (filePath === sourcePath || getFileExtension(sourcePath) !== '.pptx') return false; // shell-neutral:allow — Office extension
  const ext = getFileExtension(filePath);
  if (ext !== '.pdf' && !['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return false;
  const file = splitTurnFilePath(filePath);
  const source = splitTurnFilePath(sourcePath);
  const normalized = (name: string) =>
    name
      .replace(/\.[^.]+$/, '')
      .replace(PREVIEW_NAME, '')
      .replace(/[\s._\-—–()（）【】[\]]+/g, '')
      .toLowerCase()
      .normalize('NFC');
  if (normalized(file.name) === normalized(source.name)) return true;
  return (
    PREVIEW_NAME.test(file.name) &&
    file.dir.normalize('NFC') === source.dir.normalize('NFC')
  );
}

/** 把本轮文件按最终交付物（最终文件）与中间修改文件分类，并合并行数统计。 */
export function groupTurnFiles(
  files: TurnFile[],
  executedActions?: Array<{ tool?: string; arguments?: unknown; result?: unknown }>,
): GroupedTurnFiles {
  // 1. 过滤垃圾/临时锁定文件
  const validFiles = files.filter((f) => !isIgnoredTurnFile(f.path));

  // 2. 从 executedActions 中补充 diff 统计
  const statsByPath = new Map<string, { additions: number; deletions: number }>();
  if (Array.isArray(executedActions)) {
    for (const act of executedActions) {
      const args = act.arguments && typeof act.arguments === 'object' ? (act.arguments as Record<string, unknown>) : null;
      const rawPath = typeof args?.path === 'string' ? args.path : null;
      if (rawPath) {
        if (act.tool === 'local_edit_file') {
          const res = act.result && typeof act.result === 'object' ? (act.result as Record<string, unknown>) : null;
          if (typeof res?.diff === 'string') {
            const diffStats = parseDiffStats(res.diff);
            const prev = statsByPath.get(rawPath) ?? { additions: 0, deletions: 0 };
            statsByPath.set(rawPath, {
              additions: prev.additions + diffStats.additions,
              deletions: prev.deletions + diffStats.deletions,
            });
          }
        } else if (act.tool === 'local_write_file') {
          if (typeof args?.content === 'string') {
            const lines = args.content ? args.content.split('\n').length : 0;
            statsByPath.set(rawPath, { additions: lines, deletions: 0 });
          }
        }
      }
    }
  }

  const deliverables: TurnFile[] = [];
  const intermediates: TurnFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  const backendResolved =
    validFiles.length > 0 && validFiles.every((file) => file.selection === 'resolved');
  const deliverablePaths = backendResolved
    ? new Set(
        validFiles.filter((file) => file.category === 'deliverable').map((file) => file.path),
      )
    : selectLegacyDeliverablePaths(validFiles);

  for (const file of validFiles) {
    const cat = deliverablePaths.has(file.path) ? 'deliverable' : 'intermediate';
    // 匹配统计：尝试直接匹配或 basename 匹配
    let stats = statsByPath.get(file.path);
    if (!stats) {
      for (const [p, s] of statsByPath.entries()) {
        if (p.endsWith(file.path) || file.path.endsWith(p)) {
          stats = s;
          break;
        }
      }
    }

    const additions = file.additions ?? stats?.additions;
    const deletions = file.deletions ?? stats?.deletions;

    const enriched: TurnFile = {
      ...file,
      category: cat,
      ...(additions !== undefined ? { additions } : {}),
      ...(deletions !== undefined ? { deletions } : {}),
    };

    if (cat === 'deliverable') {
      deliverables.push(enriched);
    } else {
      intermediates.push(enriched);
      if (typeof additions === 'number') totalAdditions += additions;
      if (typeof deletions === 'number') totalDeletions += deletions;
    }
  }

  return { deliverables, intermediates, totalAdditions, totalDeletions };
}

/** 右侧栏能直接打开的扩展名。交付物优先，同层里靠前的类型优先。 */
const RIGHT_PREVIEW_EXTENSIONS = [
  '.pptx', // shell-neutral:allow — Office 幻灯片扩展名，不是产品品牌
  '.ppt', // shell-neutral:allow — Office 幻灯片扩展名，不是产品品牌
  '.docx',
  '.doc',
  '.md',
  '.markdown',
];

/**
 * 这一轮在右侧栏里该显示的文件。
 * 交付物压过脚本和中间产物；同一层里幻灯片、文档、Markdown 依次优先。
 */
export function previewPathForTurn(files: readonly TurnFile[] | undefined): string | null {
  if (!files || files.length === 0) return null;
  let best: { path: string; rank: number; deliverable: boolean } | null = null;
  for (const file of files) {
    if (isIgnoredTurnFile(file.path)) continue;
    const rank = RIGHT_PREVIEW_EXTENSIONS.indexOf(getFileExtension(file.path));
    if (rank < 0) continue;
    const deliverable = getTurnFileCategory(file) === 'deliverable';
    if (
      !best
      || (deliverable && !best.deliverable)
      || (deliverable === best.deliverable && rank < best.rank)
    ) {
      best = { path: file.path, rank, deliverable };
    }
  }
  return best?.path ?? null;
}

/**
 * 右侧预览跟着对话走。
 * 停在底部时用最近一轮有预览的产物；往上翻时只用当前看着的那条助手消息。
 */
export function followedPreviewPath(
  ordered: readonly { id: string; files?: readonly TurnFile[] }[],
  options: { atBottom: boolean; focusedId: string | null },
): { messageId: string; path: string } | null {
  const pick = (entry: { id: string; files?: readonly TurnFile[] } | undefined) => {
    if (!entry) return null;
    const path = previewPathForTurn(entry.files);
    return path ? { messageId: entry.id, path } : null;
  };
  if (options.atBottom) {
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const found = pick(ordered[index]);
      if (found) return found;
    }
    return null;
  }
  if (!options.focusedId) return null;
  return pick(ordered.find((entry) => entry.id === options.focusedId));
}
