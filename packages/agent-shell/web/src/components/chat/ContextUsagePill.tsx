import { useCallback, useEffect, useRef, useState } from 'react';
import { LuMinimize2 } from 'react-icons/lu';
import { t } from '@/i18n';
import { hasHostBridge } from '@/lib/host-bridge';
import {
  compactChat,
  getChatContextStatus,
  type ChatContextStatus,
  type CompactChatOptions,
  type CompactChatResult,
} from '@/lib/local-api';

export interface ContextUsagePillProps {
  chatId: string;
  messageCount: number;
  isStreaming: boolean;
  /** Optional latest in-memory turn usage when streaming just finished. */
  livePromptTokens?: number;
  liveCachedPromptTokens?: number;
  onCompacted?: (result: CompactChatResult) => void;
}

function formatCompactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ContextUsagePill({
  chatId,
  messageCount,
  isStreaming,
  livePromptTokens,
  liveCachedPromptTokens,
  onCompacted,
}: ContextUsagePillProps) {
  const [status, setStatus] = useState<ChatContextStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState('');
  const [compacting, setCompacting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const refreshStatus = useCallback(async () => {
    if (!chatId || !hasHostBridge()) return;
    try {
      const next = await getChatContextStatus(chatId);
      setStatus(next);
    } catch {
      // Ignore transient status fetch errors so composer toolbar never flickers.
    }
  }, [chatId]);

  useEffect(() => {
    if (messageCount === 0) {
      setStatus(null);
      return;
    }
    if (!isStreaming) {
      void refreshStatus();
    }
  }, [chatId, messageCount, isStreaming, refreshStatus]);

  useEffect(() => {
    if (!open) return;
    void refreshStatus();
    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        containerRef.current?.contains(event.target)
      ) {
        return;
      }
      setOpen(false);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [open, refreshStatus]);

  if (!hasHostBridge() || messageCount === 0) {
    return null;
  }

  const maxTokens = status?.maxContextTokens ?? 131_072;
  const estTokens = Math.max(status?.estimatedTokens ?? 0, livePromptTokens ?? 0);
  const maxBytes = status?.maxRequestBytes ?? 4_194_304;
  const estBytes = status?.estimatedBytes ?? 0;
  const promptTokens = livePromptTokens ?? status?.promptTokens ?? 0;
  const cachedTokens = liveCachedPromptTokens ?? status?.cachedPromptTokens ?? 0;
  const cacheHitPct =
    promptTokens > 0 ? Math.min(100, Math.round((cachedTokens / promptTokens) * 100)) : null;

  const tokenRatio = maxTokens > 0 ? Math.min(1, estTokens / maxTokens) : 0;
  const byteRatio = maxBytes > 0 ? Math.min(1, estBytes / maxBytes) : 0;
  const dominantRatio = Math.max(tokenRatio, byteRatio);
  const dominantPct = Math.round(dominantRatio * 100);

  const toneClass =
    dominantRatio >= 0.85
      ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
      : dominantRatio >= 0.7
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
        : 'border-agent-border/60 bg-agent-muted/40 text-agent-muted-foreground hover:text-agent-foreground';

  const barColor =
    dominantRatio >= 0.85
      ? 'bg-red-500'
      : dominantRatio >= 0.7
        ? 'bg-amber-500'
        : 'bg-agent-primary';

  const handleCompactNow = async () => {
    if (compacting) return;
    setCompacting(true);
    setFeedback(null);
    try {
      const opts: CompactChatOptions = {};
      if (focus.trim()) opts.focus = focus.trim();
      const res = await compactChat(chatId, opts);
      setFocus('');
      await refreshStatus();
      if (res.queuedOnActiveTurn) {
        setFeedback(t('Compaction queued for the next step.'));
      } else if (res.compacted > 0) {
        setFeedback(t('Compacted {count} earlier messages.', { count: res.compacted }));
        onCompacted?.(res);
      } else {
        setFeedback(t('Context is already compact.'));
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
    } finally {
      setCompacting(false);
    }
  };

  return (
    <div ref={containerRef} className="relative inline-flex items-center">
      <button
        type="button"
        data-testid="context-usage-pill"
        onClick={() => setOpen((prev) => !prev)}
        title={t('Context window and payload usage')}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-tight transition-colors ${toneClass}`}
      >
        <LuMinimize2 className="h-3 w-3 shrink-0 opacity-80" />
        <span>
          {formatCompactCount(estTokens)} · {dominantPct}%
        </span>
      </button>

      {open && (
        <div
          data-testid="context-usage-popover"
          className="absolute bottom-full left-0 z-50 mb-2 w-72 rounded-agent-lg border border-agent-border bg-agent-canvas p-3 text-xs shadow-lg"
        >
          <div className="font-medium text-agent-foreground">
            {t('Context budget')}
          </div>

          <div className="mt-2 space-y-2">
            <div>
              <div className="flex items-center justify-between text-[11px] text-agent-muted-foreground">
                <span>{t('Token window')}</span>
                <span>
                  {formatCompactCount(estTokens)} / {formatCompactCount(maxTokens)} (
                  {Math.round(tokenRatio * 100)}%)
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-agent-muted">
                <div
                  className={`h-full transition-all ${barColor}`}
                  style={{ width: `${Math.max(2, Math.round(tokenRatio * 100))}%` }}
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between text-[11px] text-agent-muted-foreground">
                <span>{t('Request body')}</span>
                <span>
                  {formatMegabytes(estBytes)} / {formatMegabytes(maxBytes)} (
                  {Math.round(byteRatio * 100)}%)
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-agent-muted">
                <div
                  className={`h-full transition-all ${barColor}`}
                  style={{ width: `${Math.max(2, Math.round(byteRatio * 100))}%` }}
                />
              </div>
            </div>

            {cacheHitPct !== null && (
              <div className="flex items-center justify-between text-[11px] text-agent-muted-foreground">
                <span>{t('Prompt cache hit')}</span>
                <span>{cacheHitPct}%</span>
              </div>
            )}

            {(status?.compactionCount ?? 0) > 0 && (
              <div className="text-[11px] text-agent-muted-foreground">
                {t('Auto-compacted {count} times in this chat', {
                  count: status?.compactionCount ?? 0,
                })}
              </div>
            )}
          </div>

          <div className="mt-3 border-t border-agent-border/60 pt-2.5">
            <label className="block text-[11px] text-agent-muted-foreground">
              {t('Keep specific details (optional)')}
            </label>
            <input
              type="text"
              data-testid="compact-focus-input"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder={t('e.g. SQL schema and error codes')}
              className="mt-1 w-full rounded-agent-md border border-agent-border bg-agent-card px-2 py-1 text-xs text-agent-foreground placeholder:text-agent-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-agent-primary"
            />
            <button
              type="button"
              data-testid="compact-now-btn"
              disabled={compacting}
              onClick={() => void handleCompactNow()}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-agent-md bg-agent-primary px-2.5 py-1.5 text-xs font-medium text-agent-primary-foreground transition hover:bg-agent-primary/90 disabled:opacity-50"
            >
              {compacting ? t('Compacting context…') : t('Compact context now')}
            </button>
            {feedback && (
              <div
                role="status"
                data-testid="compact-feedback"
                className="mt-1.5 text-[11px] text-agent-muted-foreground"
              >
                {feedback}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
