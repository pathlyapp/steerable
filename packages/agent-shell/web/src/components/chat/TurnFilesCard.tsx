import { useEffect, useRef, useState } from 'react';
import {
  LuCheck,
  LuChevronDown,
  LuCopy,
  LuExternalLink,
  LuFile,
  LuFileDiff,
  LuFileSpreadsheet,
  LuFileText,
  LuFolderOpen,
  LuImage,
  LuLoaderCircle,
  LuPresentation,
  LuUndo2,
} from 'react-icons/lu';
import { openLocalPath } from '@/lib/local-api';
import { hostToolChrome } from '@/lib/host-tools';
import { t } from '@/i18n';
import {
  formatFileSize,
  formatIntermediateDisplayPath,
  getDeliverableMeta,
  groupTurnFiles,
  splitTurnFilePath,
  type DeliverableFileMeta,
  type TurnFile,
} from './turn-files';

/**
 * TurnFilesCard — 回合产物文件展示（Codex 样式）。
 *
 * 拆分两层呈现：
 *   1. 最终文件（Deliverables）：如生成的 Excel、PPT、PDF、图片等，展示为独立的大卡片，
 *      带文件类型图标、分类标签（Spreadsheet · XLSX）、以及「Open in ⌵」下拉打开操作。
 *   2. 中间修改文件（Edited files）：如脚本、代码等修改，展示为「Edited N files (+X -Y)」
 *      可折叠卡片，包含 Review 按钮与细粒度行变动列表。
 */

export interface ExecutedActionLike {
  tool?: string;
  arguments?: unknown;
  result?: unknown;
}

interface TurnFilesCardProps {
  files: TurnFile[];
  executedActions?: ExecutedActionLike[];
}

export function TurnFilesCard({ files, executedActions }: TurnFilesCardProps) {
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [openError, setOpenError] = useState<{ path: string; message: string } | null>(null);
  const allowOpenPath = hostToolChrome('local-fs');

  const { deliverables, intermediates, totalAdditions, totalDeletions } = groupTurnFiles(
    files,
    executedActions,
  );

  if (deliverables.length === 0 && intermediates.length === 0) return null;

  const handleOpen = async (filePath: string) => {
    if (!allowOpenPath) return;
    if (openingPath) return;
    setOpeningPath(filePath);
    setOpenError(null);
    try {
      const result = await openLocalPath(filePath);
      if (!result.success) {
        setOpenError({ path: filePath, message: result.error || t('Could not open') });
      }
    } catch (err) {
      setOpenError({
        path: filePath,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setOpeningPath(null);
    }
  };

  const handleReveal = async (filePath: string) => {
    const { dir } = splitTurnFilePath(filePath);
    const targetDir = dir || filePath;
    await handleOpen(targetDir);
  };

  return (
    <div className="space-y-2.5" data-turn-files="">
      {/* 1. 最终文件卡片区 (Deliverables) */}
      {deliverables.length > 0 && (
        <div className="space-y-2" data-turn-deliverables="">
          {deliverables.map((file) => (
            <DeliverableCard
              key={file.path}
              file={file}
              onOpen={() => void handleOpen(file.path)}
              onReveal={() => void handleReveal(file.path)}
              busy={openingPath === file.path}
              error={openError?.path === file.path ? openError.message : null}
              allowOpen={allowOpenPath}
            />
          ))}
        </div>
      )}

      {/* 2. 中间修改文件区 (Edited Files) */}
      {intermediates.length > 0 && (
        <EditedFilesCard
          files={intermediates}
          totalAdditions={totalAdditions}
          totalDeletions={totalDeletions}
          onOpen={(f) => void handleOpen(f.path)}
          openingPath={openingPath}
          openError={openError}
          allowOpen={allowOpenPath}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 最终交付文件卡片 (Codex Deliverable Card)
// ─────────────────────────────────────────────────────────────

interface DeliverableCardProps {
  file: TurnFile;
  onOpen: () => void;
  onReveal: () => void;
  busy: boolean;
  error: string | null;
  allowOpen: boolean;
}

function DeliverableCard({
  file,
  onOpen,
  onReveal,
  busy,
  error,
  allowOpen,
}: DeliverableCardProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { name } = splitTurnFilePath(file.path);
  const size = formatFileSize(file.size);
  const meta = getDeliverableMeta(file.path);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dropdownOpen]);

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(file.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div
      className="rounded-agent-lg border border-agent-border bg-agent-canvas p-2.5 shadow-xs transition-all hover:border-agent-border/80"
      data-deliverable-card=""
      data-turn-file=""
      data-kind={file.kind}
    >
      <div className="flex items-center justify-between gap-2.5">
        {/* 左侧：文件图标 */}
        <div className="shrink-0">
          <DeliverableIcon meta={meta} />
        </div>

        {/* 中间：文件名与类型信息 */}
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onOpen}
            disabled={!allowOpen || busy}
            title={file.path}
            className={`block w-full truncate text-left text-xs font-medium text-agent-foreground ${
              allowOpen ? 'hover:underline cursor-pointer' : 'cursor-default'
            }`}
          >
            {name}
          </button>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-agent-muted-foreground">
            <span className="truncate" title={file.description}>
              {file.description ?? `${t(meta.label)} · ${meta.extBadge}`}
            </span>
            {size && (
              <>
                <span className="shrink-0 opacity-40">·</span>
                <span className="shrink-0 tabular-nums">{size}</span>
              </>
            )}
          </div>
        </div>

        {/* 右侧：Open in ⌵ 动作按钮 */}
        <div className="relative shrink-0" ref={menuRef}>
          <div className="flex items-center rounded-agent-md border border-agent-border bg-agent-canvas shadow-xs hover:border-agent-border/80 transition-colors">
            <button
              type="button"
              onClick={onOpen}
              disabled={!allowOpen || busy}
              title={file.path}
              className="flex items-center gap-1.5 rounded-l-agent-md px-2.5 py-1 text-xs font-medium text-agent-foreground hover:bg-agent-muted/50 transition-colors disabled:cursor-wait"
            >
              {busy ? (
                <LuLoaderCircle className="h-3.5 w-3.5 animate-spin text-agent-muted-foreground" />
              ) : null}
              <span>{t('Open with')}</span>
            </button>
            <button
              type="button"
              onClick={() => setDropdownOpen(!dropdownOpen)}
              disabled={!allowOpen}
              aria-label={t('More actions')}
              className="border-l border-agent-border px-1.5 py-1 text-agent-muted-foreground hover:bg-agent-muted/50 hover:text-agent-foreground rounded-r-agent-md transition-colors"
            >
              <LuChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* 下拉菜单 */}
          {dropdownOpen && (
            <div className="absolute right-0 top-full z-30 mt-1.5 w-44 rounded-agent-md border border-agent-border bg-agent-canvas py-1 shadow-lg text-xs">
              <button
                type="button"
                onClick={() => {
                  setDropdownOpen(false);
                  onOpen();
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-agent-foreground hover:bg-agent-foreground/5"
              >
                <LuExternalLink className="h-3.5 w-3.5 text-agent-muted-foreground" />
                <span>{t('Open with default app')}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setDropdownOpen(false);
                  onReveal();
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-agent-foreground hover:bg-agent-foreground/5"
              >
                <LuFolderOpen className="h-3.5 w-3.5 text-agent-muted-foreground" />
                <span>{t('Show in folder')}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleCopyPath();
                  setTimeout(() => setDropdownOpen(false), 800);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-agent-foreground hover:bg-agent-foreground/5"
              >
                {copied ? (
                  <LuCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <LuCopy className="h-3.5 w-3.5 text-agent-muted-foreground" />
                )}
                <span>{copied ? t('Copied full path') : t('Copy file path')}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-2 px-1 text-[11px] text-agent-destructive" role="status">
          {t('Could not open: {error}', { error })}
        </div>
      )}
    </div>
  );
}

function DeliverableIcon({ meta }: { meta: DeliverableFileMeta }) {
  switch (meta.themeColor) {
    case 'emerald':
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-agent-md border border-emerald-500/35 text-emerald-600 dark:text-emerald-400">
          <LuFileSpreadsheet className="h-4 w-4" />
        </div>
      );
    case 'amber':
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-agent-md border border-amber-500/35 text-amber-600 dark:text-amber-400">
          <LuPresentation className="h-4 w-4" />
        </div>
      );
    case 'rose':
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-agent-md border border-rose-500/35 text-rose-600 dark:text-rose-400">
          <LuFileText className="h-4 w-4" />
        </div>
      );
    case 'blue':
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-agent-md border border-blue-500/35 text-blue-600 dark:text-blue-400">
          <LuFileText className="h-4 w-4" />
        </div>
      );
    case 'purple':
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-agent-md border border-purple-500/35 text-purple-600 dark:text-purple-400">
          <LuImage className="h-4 w-4" />
        </div>
      );
    default:
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-agent-md border border-agent-border text-agent-muted-foreground">
          <LuFile className="h-4 w-4" />
        </div>
      );
  }
}

// ─────────────────────────────────────────────────────────────
// 中间修改文件卡片 (Codex Edited Files Card)
// ─────────────────────────────────────────────────────────────

interface EditedFilesCardProps {
  files: TurnFile[];
  totalAdditions: number;
  totalDeletions: number;
  onOpen: (file: TurnFile) => void;
  openingPath: string | null;
  openError: { path: string; message: string } | null;
  allowOpen: boolean;
}

function EditedFilesCard({
  files,
  totalAdditions,
  totalDeletions,
  onOpen,
  openingPath,
  openError,
  allowOpen,
}: EditedFilesCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="rounded-agent-lg border border-agent-border bg-agent-canvas shadow-xs overflow-hidden"
      data-edited-files-card=""
    >
      {/* 头部标题与统计（默认折叠，点击标题栏或 Review 展开） */}
      <div
        className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-agent-foreground/[0.03] transition-colors select-none"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-agent-sm border border-agent-border bg-agent-muted/30 text-agent-foreground/80">
            <LuFileDiff className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-agent-foreground">
              {t('Changed {count} files', { count: files.length })}
            </div>
            {(totalAdditions > 0 || totalDeletions > 0) && (
              <div className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-agent-muted-foreground">
                <span className="font-medium text-emerald-600 dark:text-emerald-400">
                  +{totalAdditions}
                </span>
                <span>-{totalDeletions}</span>
              </div>
            )}
          </div>
        </div>

        {/* 右侧动作按钮：Undo 与 查看详情 */}
        <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            disabled
            title={t('Undo file changes from this turn')}
            className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-agent-muted-foreground/50 cursor-default"
          >
            <span>{t('Undo')}</span>
            <LuUndo2 className="h-3 w-3" />
          </button>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="rounded-agent-md border border-agent-border bg-agent-canvas px-2.5 py-0.5 text-xs font-medium text-agent-foreground hover:bg-agent-muted/50 transition-colors"
          >
            {t('View details')}
          </button>
        </div>
      </div>

      {/* 文件列表 */}
      {expanded && (
        <ul className="max-h-60 overflow-y-auto border-t border-agent-border/60 divide-y divide-agent-border/40 py-0.5">
          {files.map((file) => {
            const displayPath = formatIntermediateDisplayPath(file.path);
            const size = formatFileSize(file.size);
            const busy = openingPath === file.path;
            const error = openError?.path === file.path ? openError.message : null;
            const hasDiffStats =
              typeof file.additions === 'number' || typeof file.deletions === 'number';

            return (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => onOpen(file)}
                  disabled={!allowOpen || openingPath !== null}
                  title={file.path}
                  className={`group flex w-full items-center justify-between px-3 py-1.5 text-left text-xs transition-colors ${
                    allowOpen
                      ? 'hover:bg-agent-foreground/5 cursor-pointer disabled:cursor-wait'
                      : 'cursor-default'
                  }`}
                  data-turn-file=""
                  data-kind={file.kind}
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-agent-foreground/90 group-hover:text-agent-foreground">
                    {displayPath}
                  </span>

                  <span className="shrink-0 pl-2">
                    {busy ? (
                      <LuLoaderCircle className="h-3.5 w-3.5 animate-spin text-agent-muted-foreground" />
                    ) : hasDiffStats ? (
                      <span className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
                        <span className="font-medium text-emerald-600 dark:text-emerald-400">
                          +{file.additions ?? 0}
                        </span>
                        <span className="text-agent-muted-foreground">
                          -{file.deletions ?? 0}
                        </span>
                      </span>
                    ) : size ? (
                      <span className="text-[11px] text-agent-muted-foreground tabular-nums">
                        {size}
                      </span>
                    ) : null}
                  </span>
                </button>

                {error && (
                  <div className="px-3 pb-1 text-[11px] text-agent-destructive" role="status">
                    {t('Could not open: {error}', { error })}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default TurnFilesCard;
