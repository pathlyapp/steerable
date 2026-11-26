/**
 * `present_files`：模型声明本轮的最终交付文件。
 *
 * 回合产物列表（turn-files）把声明过的文件渲染成交付卡片，其余本轮写过的
 * 文件归入「Edited N files」。只看扩展名分不清交付物与检查用的预览图、
 * 导出副本，所以由模型显式声明。工具只 stat 元数据、不读内容，也不复制
 * 文件——用户打开的是源文件当前版本。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Principal, VerifierIssue } from '@steerable/pack-sdk';
import { LOCAL_DEFAULT_PRINCIPAL } from './auth/index.js';
import type { ArtifactPurpose } from './local-backend/turn-file-selection.js';
import { getUserDataDir } from './runtime.js';
import { listDeliverableVerifiers } from './scenario/applications.js';
import { ensurePhase9Store } from './storage/fde-fallback.js';
import type { ChatDeliverableRecord } from './storage/fde-types.js';
import type { ScopedStore } from './storage/scoped-store.js';

export const PRESENT_FILES_TOOL_NAME = 'present_files';
export const DELIVERABLE_VERIFIER_TIMEOUT_MS = 15_000;

/** 单次调用最多声明的文件数；交付卡片过多就失去「最终结果」的意义。 */
const MAX_PRESENTED_FILES = 4;

export const PRESENT_FILES_SCHEMA = {
  name: PRESENT_FILES_TOOL_NAME,
  description:
    'Declare existing local files as the final deliverables of this turn. ' +
    'When a file you created or updated is an output the user asked to receive ' +
    '(spreadsheet, slide deck, document, report, image, exported archive), call this after writing it ' +
    'and before your final reply, including files produced by scripts or commands. ' +
    'Set purpose="output" for every independent deliverable. If you include a preview or intermediate ' +
    'file for context, label it purpose="preview" or purpose="intermediate"; those files stay in the ' +
    'edited-files list. Do not label helper scripts or layout-check screenshots as outputs.',
  mode: 'read' as const,
  inputSchema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_PRESENTED_FILES,
        description: `Usually the 1-2 most important deliverables; at most ${MAX_PRESENTED_FILES}.`,
        items: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absolute path, or a path relative to the project root.',
            },
            description: {
              type: 'string',
              description: 'Optional one-line summary shown on the file card.',
            },
            purpose: {
              type: 'string',
              enum: ['output', 'preview', 'intermediate'],
              description:
                'Use output for an independent final deliverable; preview/intermediate never creates a deliverable card.',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    required: ['files'],
    additionalProperties: false,
  },
};

export interface PresentedFile {
  path: string;
  description?: string;
  purpose?: ArtifactPurpose;
}

/**
 * 把参数里的路径解析成绝对路径：展开 `~/`，相对路径按项目根解析；
 * 无项目根的相对路径无法定位，返回 null。
 */
export function resolvePresentedPath(
  raw: string,
  projectRoot: string | null,
  homeDir: string = os.homedir(),
): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const expanded =
    trimmed === '~' || trimmed.startsWith('~/')
      ? path.join(homeDir, trimmed.slice(1))
      : trimmed;
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return projectRoot ? path.resolve(projectRoot, expanded) : null;
}

/** 从工具参数里取出声明的文件（不校验存在性）；形状不符的条目跳过。 */
export function readPresentedArgs(
  args: unknown,
  projectRoot: string | null,
  homeDir?: string,
): PresentedFile[] {
  if (!args || typeof args !== 'object') return [];
  const files = (args as Record<string, unknown>).files;
  if (!Array.isArray(files)) return [];
  const out: PresentedFile[] = [];
  for (const item of files) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.path !== 'string') continue;
    const resolved = resolvePresentedPath(record.path, projectRoot, homeDir);
    if (!resolved) continue;
    const description =
      typeof record.description === 'string' ? record.description.trim() : '';
    const purpose =
      record.purpose === 'output' ||
      record.purpose === 'preview' ||
      record.purpose === 'intermediate'
        ? record.purpose
        : undefined;
    out.push({
      path: resolved,
      ...(description ? { description } : {}),
      ...(purpose ? { purpose } : {}),
    });
  }
  return out;
}

export interface PresentFilesVerifyContext {
  readonly store?: ScopedStore;
  readonly chatId?: string;
  readonly principal?: Principal;
  readonly messageId?: string | null;
  readonly executedActions?: readonly {
    readonly id?: string;
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
    readonly success: boolean;
  }[];
  readonly verifierTimeoutMs?: number;
}

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf':
      return 'application/pdf';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.md':
      return 'text/markdown';
    case '.json':
      return 'application/json';
    case '.csv':
      return 'text/csv';
    case '.txt':
      return 'text/plain';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}

async function runVerifierWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  verifierId: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`DeliverableVerifier "${verifierId}" timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 执行 `present_files`：每个路径必须是已存在的普通文件。任一路径不合格时
 * 整次调用失败并逐个说明原因，模型可以修正后重试。
 *
 * 当 `purpose === 'output'` 时执行匹配的 `DeliverableVerifier`（15s 硬超时）：
 * - 存在 blocking 问题或校验器抛错/超时 → 返回 `{ success: false, needsFollowup: true, data: { blockers } }` 拦截未达标产物；
 * - 通过后归档只读快照至 `<userDataDir>/deliverables/<chatId>/<sha256><ext>` 并记入 `chat_deliverables`。
 */
export async function executePresentFiles(
  args: Record<string, unknown>,
  projectRoot: string | null,
  verifyContext?: PresentFilesVerifyContext,
): Promise<
  | {
      success: true;
      presented: PresentedFile[];
      deliverables?: ChatDeliverableRecord[];
    }
  | {
      success: false;
      error: string;
      needsFollowup?: boolean;
      data?: Record<string, unknown>;
    }
> {
  const rawFiles = Array.isArray(args.files) ? args.files : [];
  if (rawFiles.length === 0) {
    return { success: false, error: 'files must list at least one file to present.' };
  }
  if (rawFiles.length > MAX_PRESENTED_FILES) {
    return {
      success: false,
      error: `Present at most ${MAX_PRESENTED_FILES} files per call; keep only the final deliverables.`,
    };
  }
  const problems: string[] = [];
  const presented: PresentedFile[] = [];
  for (const item of rawFiles) {
    const raw =
      item && typeof item === 'object' && typeof (item as Record<string, unknown>).path === 'string'
        ? ((item as Record<string, unknown>).path as string)
        : '';
    const [file] = readPresentedArgs({ files: [item] }, projectRoot);
    if (!file) {
      problems.push(
        raw
          ? `${raw}: use an absolute path (no project root to resolve a relative path).`
          : 'each entry needs a non-empty path.',
      );
      continue;
    }
    try {
      const stat = await fs.stat(file.path);
      if (!stat.isFile()) {
        problems.push(`${file.path}: not a regular file.`);
        continue;
      }
    } catch {
      // stat 失败（多为 ENOENT）：报给模型让它先写文件或修正路径。
      problems.push(`${file.path}: file not found. Create it first or fix the path.`);
      continue;
    }
    presented.push(file);
  }
  if (problems.length > 0) {
    return { success: false, error: `Cannot present: ${problems.join(' ')}` };
  }

  const verifiers = listDeliverableVerifiers();
  const allBlockers: Array<VerifierIssue & { filePath: string; verifierId: string }> = [];
  const archivedDeliverables: ChatDeliverableRecord[] = [];
  const timeoutMs = verifyContext?.verifierTimeoutMs ?? DELIVERABLE_VERIFIER_TIMEOUT_MS;
  const principal = verifyContext?.principal ?? LOCAL_DEFAULT_PRINCIPAL;
  const chatId = verifyContext?.chatId ?? 'local';

  for (const file of presented) {
    if (file.purpose !== 'output') continue;
    const ext = path.extname(file.path).toLowerCase();
    const mimeType = guessMimeType(file.path);
    const matching = verifiers.filter((v) => {
      const extMatch =
        !v.matchExtensions ||
        v.matchExtensions.length === 0 ||
        v.matchExtensions.some((e) => e.toLowerCase() === ext);
      const mimeMatch =
        !v.matchMimeTypes ||
        v.matchMimeTypes.length === 0 ||
        v.matchMimeTypes.includes(mimeType);
      return extMatch && mimeMatch;
    });

    const collectedIssues: VerifierIssue[] = [];
    const summaries: string[] = [];
    let matchedVerifierId: string | null = null;

    for (const verifier of matching) {
      matchedVerifierId = verifier.id;
      try {
        const res = await runVerifierWithTimeout(
          verifier.verify({
            filePath: file.path,
            chatId,
            principal,
            executedActions: verifyContext?.executedActions ?? [],
          }),
          timeoutMs,
          verifier.id,
        );
        if (res.summary) summaries.push(res.summary);
        for (const issue of res.issues) {
          collectedIssues.push(issue);
          if (issue.severity === 'blocking') {
            allBlockers.push({ ...issue, filePath: file.path, verifierId: verifier.id });
          }
        }
        if (res.status === 'failed' && !res.issues.some((i) => i.severity === 'blocking')) {
          const synthetic: VerifierIssue = {
            severity: 'blocking',
            code: 'verification_failed',
            message: res.summary || `Verifier "${verifier.id}" reported failed status`,
          };
          collectedIssues.push(synthetic);
          allBlockers.push({ ...synthetic, filePath: file.path, verifierId: verifier.id });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const blocker: VerifierIssue = {
          severity: 'blocking',
          code: 'verifier_exception',
          message: msg,
        };
        collectedIssues.push(blocker);
        allBlockers.push({ ...blocker, filePath: file.path, verifierId: verifier.id });
      }
    }

    if (allBlockers.some((b) => b.filePath === file.path)) {
      continue;
    }

    // Archive immutable snapshot when verifyContext.store is provided or verifiers ran
    if (verifyContext?.store || matching.length > 0) {
      const bytes = await fs.readFile(file.path);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const archiveDir = path.join(getUserDataDir(), 'deliverables', chatId);
      await fs.mkdir(archiveDir, { recursive: true });
      const snapshotPath = path.join(archiveDir, `${sha256}${ext}`);
      try {
        await fs.stat(snapshotPath);
      } catch {
        await fs.writeFile(snapshotPath, bytes, { mode: 0o444 });
      }
      if (verifyContext?.store) {
        const hasWarnings = collectedIssues.some((i) => i.severity === 'warning');
        const verificationStatus =
          matching.length === 0
            ? 'unverified'
            : hasWarnings
              ? 'warnings'
              : 'verified';
        const saved = await ensurePhase9Store(verifyContext.store).saveChatDeliverable({
          chatId,
          messageId: verifyContext.messageId ?? null,
          filePath: file.path,
          fileName: path.basename(file.path),
          mimeType,
          sizeBytes: bytes.byteLength,
          sha256,
          verificationStatus,
          verifierId: matchedVerifierId,
          issues: collectedIssues,
          summary: summaries.length > 0 ? summaries.join('; ') : null,
          reportPath: snapshotPath,
        });
        archivedDeliverables.push(saved);
      }
    }
  }

  if (allBlockers.length > 0) {
    const summaryText = allBlockers
      .map((b) => `[${b.code}] ${path.basename(b.filePath)}: ${b.message}`)
      .join('; ');
    return {
      success: false,
      error: `deliverable_verification_failed: ${summaryText}`,
      needsFollowup: true,
      data: {
        blockers: allBlockers,
        blockingCount: allBlockers.length,
      },
    };
  }

  return {
    success: true,
    presented,
    ...(archivedDeliverables.length > 0 ? { deliverables: archivedDeliverables } : {}),
  };
}
