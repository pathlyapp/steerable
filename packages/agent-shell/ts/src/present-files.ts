/**
 * `present_files`：模型声明本轮的最终交付文件。
 *
 * 回合产物列表（turn-files）把声明过的文件渲染成交付卡片，其余本轮写过的
 * 文件归入「Edited N files」。只看扩展名分不清交付物与检查用的预览图、
 * 导出副本，所以由模型显式声明。工具只 stat 元数据、不读内容，也不复制
 * 文件——用户打开的是源文件当前版本。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ArtifactPurpose } from './local-backend/turn-file-selection.js';

export const PRESENT_FILES_TOOL_NAME = 'present_files';

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

/**
 * 执行 `present_files`：每个路径必须是已存在的普通文件。任一路径不合格时
 * 整次调用失败并逐个说明原因，模型可以修正后重试。
 */
export async function executePresentFiles(
  args: Record<string, unknown>,
  projectRoot: string | null,
): Promise<{ success: true; presented: PresentedFile[] } | { success: false; error: string }> {
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
  return { success: true, presented };
}
