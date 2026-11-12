/**
 * 本轮哪些文件升成交付卡片。
 *
 * 证据优先级：生成流程结构化结果 > 最终回复引用 > present_files > 文件扫描。
 * 启发式只纠正没有明确 purpose 的 present_files 和扫描结果；明确标为 output
 * 的同名 PDF 与幻灯片会同时保留。
 */

import path from 'node:path';

const SOURCE_EXTENSIONS = new Set([
  '.pptx', '.ppt', '.key', // shell-neutral:allow — Office 幻灯片扩展名，不是产品品牌
  '.docx', '.doc', '.pages',
  '.xlsx', '.xls', '.xlsm', '.numbers',
]);

const PRESENTATION_EXTENSIONS = new Set([
  '.pptx', '.ppt', '.key', // shell-neutral:allow — Office 幻灯片扩展名，不是产品品牌
]);

const IMAGE_OR_PDF_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
]);

const RENDER_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.html', '.htm', '.csv', '.tsv',
  '.zip', '.tar', '.gz', '.7z',
  '.mp4', '.mov', '.mp3', '.epub', '.rtf',
]);

const HELPER_EXTENSIONS = new Set([
  '.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.rb', '.go', '.rs',
  '.java', '.css', '.json', '.yml', '.yaml', '.toml',
]);

const PREVIEW_NAME = /预览|截图|图像版|preview|screenshot|thumbnail/i;

/** 没有办公文件时，自动升成卡片的渲染文件上限。再多就交给 present_files 点名。 */
const AUTO_RENDER_MAX = 4;

export type ArtifactPurpose = 'output' | 'preview' | 'intermediate';
export type DeliveryEvidenceSource = 'generation' | 'final-reference' | 'present-files';

export interface DeliveryEvidence {
  path: string;
  source: DeliveryEvidenceSource;
  /** present_files 的旧调用没有 purpose，此时才允许启发式纠错。 */
  purpose?: ArtifactPurpose;
}

/**
 * 选出本轮交付卡片的路径。结构化证据不会被文件名启发式覆盖。
 */
export function selectDeliverablePaths(
  files: readonly { path: string }[],
  evidence: readonly DeliveryEvidence[],
): Set<string> {
  const unique: { path: string }[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    unique.push(file);
  }

  const strongest = strongestEvidence(evidence, seen);
  const explicitOutputs = new Set(
    [...strongest.values()]
      .filter((item) => item.purpose === 'output')
      .map((item) => item.path),
  );
  const excluded = new Set(
    [...strongest.values()]
      .filter((item) => item.purpose === 'preview' || item.purpose === 'intermediate')
      .map((item) => item.path),
  );
  const ambiguousReferences = new Set(
    [...strongest.values()]
      .filter((item) => item.purpose === undefined)
      .map((item) => item.path),
  );
  const sources = unique.filter((file) => isSource(file.path)).map((file) => file.path);
  const availableSources = sources.filter((item) => !excluded.has(item));
  const outsideSources = availableSources.filter((item) => !inAgentScratch(item));
  const sourcePool = outsideSources.length > 0 ? outsideSources : availableSources;

  let inferred: string[];
  if (ambiguousReferences.size > 0) {
    inferred = [...ambiguousReferences].filter(
      (item) => !excluded.has(item) && !isShadow(item, availableSources),
    );
    const parents = availableSources.filter((source) =>
      [...ambiguousReferences].some((item) => isShadowOf(item, source)),
    );
    const outsideParents = parents.filter((item) => !inAgentScratch(item));
    for (const source of outsideParents.length > 0 ? outsideParents : parents) {
      if (!inferred.includes(source)) inferred.push(source);
    }
    // 点名的全是脚本或预览、本轮又只有一份办公文件：卡片给那一份，不给脚本。
    const onlySource = sourcePool.length === 1 ? sourcePool[0] : undefined;
    if (
      onlySource &&
      !inferred.some((item) => isSource(item)) &&
      [...ambiguousReferences].every(
        (item) => isHelper(item) || isShadow(item, availableSources),
      )
    ) {
      inferred = [onlySource];
    }
    if (inferred.some((item) => isSource(item))) {
      inferred = inferred.filter((item) => !isHelper(item));
    }
    if (inferred.length === 0) {
      inferred = [...ambiguousReferences].filter((item) => !excluded.has(item));
    }
  } else if (explicitOutputs.size > 0) {
    inferred = [];
  } else if (sourcePool.length > 0) {
    inferred = [...sourcePool];
  } else {
    inferred = autoRenders(unique.filter((file) => !excluded.has(file.path)));
  }

  return new Set([...explicitOutputs, ...inferred]);
}

function strongestEvidence(
  evidence: readonly DeliveryEvidence[],
  knownPaths: ReadonlySet<string>,
): Map<string, DeliveryEvidence> {
  const strongest = new Map<string, DeliveryEvidence>();
  for (const item of evidence) {
    if (!knownPaths.has(item.path)) continue;
    const previous = strongest.get(item.path);
    if (
      !previous ||
      evidenceRank(item.source) > evidenceRank(previous.source) ||
      (item.source === previous.source &&
        item.purpose !== undefined &&
        previous.purpose === undefined)
    ) {
      strongest.set(item.path, item);
    }
  }
  return strongest;
}

function evidenceRank(source: DeliveryEvidenceSource): number {
  switch (source) {
    case 'generation':
      return 3;
    case 'final-reference':
      return 2;
    case 'present-files':
      return 1;
  }
}

function autoRenders(files: readonly { path: string }[]): string[] {
  const renders = files.filter((file) => isRender(file.path) && !inAgentScratch(file.path));
  const plain = renders.filter((file) => !previewName(file.path));
  const pool = plain.length > 0 ? plain : renders;
  if (pool.length === 0 || pool.length > AUTO_RENDER_MAX) return [];
  return pool.map((file) => file.path);
}

function isShadow(filePath: string, sources: readonly string[]): boolean {
  return sources.some((source) => isShadowOf(filePath, source));
}

/** 预览 PDF / 截图：和幻灯片同干名，或文件名像预览且跟办公文件在同一目录。 */
function isShadowOf(filePath: string, sourcePath: string): boolean {
  if (filePath === sourcePath || !isSource(sourcePath) || !isRender(filePath)) return false;
  if (
    stemsMatch(filePath, sourcePath) &&
    isPresentation(sourcePath) &&
    isImageOrPdf(filePath)
  ) {
    return true;
  }
  return previewName(filePath) && sameDir(filePath, sourcePath);
}

function isSource(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(extensionOf(filePath));
}

function isPresentation(filePath: string): boolean {
  return PRESENTATION_EXTENSIONS.has(extensionOf(filePath));
}

function isImageOrPdf(filePath: string): boolean {
  return IMAGE_OR_PDF_EXTENSIONS.has(extensionOf(filePath));
}

function isRender(filePath: string): boolean {
  return RENDER_EXTENSIONS.has(extensionOf(filePath));
}

function isHelper(filePath: string): boolean {
  return HELPER_EXTENSIONS.has(extensionOf(filePath));
}

function previewName(filePath: string): boolean {
  return PREVIEW_NAME.test(path.basename(filePath));
}

function extensionOf(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function stemsMatch(left: string, right: string): boolean {
  const a = stemKey(left);
  const b = stemKey(right);
  return a.length > 0 && a === b;
}

function stemKey(filePath: string): string {
  const base = path.basename(filePath);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return stem
    .replace(/预览|截图|图像版/g, '')
    .replace(/preview|screenshot|thumbnail/gi, '')
    .replace(/[\s._\-—–()（）【】[\]]+/g, '')
    .toLowerCase()
    .normalize('NFC');
}

function sameDir(left: string, right: string): boolean {
  return directoryOf(left) === directoryOf(right);
}

function directoryOf(filePath: string): string {
  return path.dirname(filePath).replace(/\\/g, '/').replace(/\/+$/, '').normalize('NFC');
}

function inAgentScratch(filePath: string): boolean {
  return /(?:^|[/\\])(?:review_work|scripts)(?:[/\\]|$)/i.test(filePath);
}
