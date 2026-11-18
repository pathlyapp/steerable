import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { LuChevronDown, LuChevronRight } from 'react-icons/lu';
import {
  useThinkingDisplay,
  type ThinkingDisplayMode,
} from '@/lib/show-thinking-content';
import {
  estimateReasoningDurationMs,
  processStatusLabel,
  thinkingFoldLabel,
} from './process-status';
import {
  compactProcessBlocks,
  splitTurnProcess,
  type ProcessTimelineBlock,
} from './turn-timeline';

/**
 * Shared Codex / DeepSeek-style turn process disclosure.
 *
 * Separates intermediate process steps (`reasoning`, `tools`, pre-tool `text`)
 * from the trailing final answer, tracks per-round thinking durations while
 * streaming, and collapses finished work behind one summary line. When
 * `thinkingDisplay === 'hidden'`, reasoning blocks are filtered out and
 * adjacent tool groups merge into a single block.
 */

export const THINKING_PEEK_LINES = 5;
/** 思考正文行高（`leading-snug`）。 */
const THINKING_LINE_HEIGHT = 1.375;
/**
 * 最多 5 行：用 max-height，短思考按内容收，不撑空。
 * 不用 CSS `lh`：Windows Electron 在中文字体尚未就绪时 `lh` 会算成 0，
 * 思考 peek 整块消失，字体加载后又把主列表高度撑跳。
 */
export const THINKING_PEEK_HEIGHT = `${THINKING_PEEK_LINES * THINKING_LINE_HEIGHT}em`;

const THINKING_TEXT =
  'border-l border-agent-border/70 pl-2 text-xs leading-snug text-agent-muted-foreground';

function splitThinkingParagraphs(content: string): string[] {
  return content.split(/\n{2,}/).filter((part) => part.length > 0);
}

function ReasoningBody({
  content,
  showCursor,
}: {
  content: string;
  showCursor?: boolean;
}) {
  const parts = splitThinkingParagraphs(content);
  return (
    <>
      <div className="space-y-1">
        {parts.map((part, index) => (
          <div key={index} className="whitespace-pre-wrap break-words">
            {part}
          </div>
        ))}
      </div>
      {showCursor ? (
        <span className="ml-0.5 inline-block h-3 w-[2px] animate-agent-cursor-blink bg-agent-muted-foreground/60 align-text-bottom" />
      ) : null}
    </>
  );
}

export function resolveThinkingDisplay(
  preference: ThinkingDisplayMode,
  thinkingDisplay?: ThinkingDisplayMode,
  showThinkingContent?: boolean,
): ThinkingDisplayMode {
  if (thinkingDisplay) return thinkingDisplay;
  if (showThinkingContent === true) return 'full';
  if (showThinkingContent === false) return 'peek';
  return preference;
}

function useLiveNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [enabled]);
  return now;
}

function ReasoningPane({
  content,
  showCursor,
  clipped,
}: {
  content: string;
  showCursor?: boolean;
  clipped?: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!clipped) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [clipped, content]);
  const body = (
    <div className={THINKING_TEXT}>
      <ReasoningBody content={content} showCursor={showCursor} />
    </div>
  );
  if (!clipped) return body;
  return (
    <div
      ref={scrollerRef}
      className="overflow-y-auto overflow-anchor-none [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      style={{ maxHeight: THINKING_PEEK_HEIGHT }}
      data-thinking-peek=""
      data-testid="thinking-peek"
      data-peek-lines={THINKING_PEEK_LINES}
    >
      {body}
    </div>
  );
}

function ThinkingFold({
  content,
  label,
  showCursor,
  mode,
  defaultOpen,
}: {
  content: string;
  label: string;
  showCursor?: boolean;
  mode: ThinkingDisplayMode;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);

  if (mode === 'hidden') return null;

  return (
    <div className="space-y-1" data-testid="turn-thinking">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex min-w-0 items-center gap-1 py-0.5 text-left text-[11px] text-agent-muted-foreground/80 transition-colors hover:text-agent-foreground"
        aria-expanded={open}
        data-thinking-fold=""
      >
        <span className="truncate">{label}</span>
        {open ? (
          <LuChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <LuChevronRight className="h-3 w-3 shrink-0" />
        )}
      </button>
      {open ? (
        <ReasoningPane
          content={content}
          showCursor={showCursor}
          clipped={mode === 'peek'}
        />
      ) : null}
    </div>
  );
}

export interface TurnProcessTimelineProps<TTool = unknown> {
  blocks: ReadonlyArray<ProcessTimelineBlock<TTool>>;
  isStreaming: boolean;
  startedAtMs?: number;
  durationMs?: number;
  thinkingDisplay?: ThinkingDisplayMode;
  showThinkingContent?: boolean;
  collapseWhenFinished?: boolean;
  /** When thinkingDisplay === 'hidden', omit reasoning and merge adjacent tool groups. Default true. */
  compactHiddenProcess?: boolean;
  emptyFallback?: ReactNode;
  streamingHint?: ReactNode;
  processFooter?: ReactNode;
  renderTools: (actions: TTool[], index: number) => ReactNode;
  renderIntermediateText: (
    block: Extract<ProcessTimelineBlock<TTool>, { type: 'text' }>,
    isLiveLast: boolean,
    index: number,
  ) => ReactNode;
  renderAnswer: (
    block: Extract<ProcessTimelineBlock<TTool>, { type: 'text' }>,
    isLast: boolean,
    index: number,
  ) => ReactNode;
}

export function TurnProcessTimeline<TTool = unknown>({
  blocks,
  isStreaming,
  startedAtMs,
  durationMs,
  thinkingDisplay: thinkingDisplayProp,
  showThinkingContent: showThinkingContentProp,
  collapseWhenFinished = true,
  compactHiddenProcess = true,
  emptyFallback,
  streamingHint,
  processFooter,
  renderTools,
  renderIntermediateText,
  renderAnswer,
}: TurnProcessTimelineProps<TTool>) {
  const preference = useThinkingDisplay();
  const thinkingDisplay = resolveThinkingDisplay(
    preference,
    thinkingDisplayProp,
    showThinkingContentProp,
  );
  const showFullThinking = thinkingDisplay === 'full';
  const hideThinking = thinkingDisplay === 'hidden';
  const { process, answer } = splitTurnProcess(blocks, { finalize: !isStreaming });
  const visibleProcess = compactProcessBlocks(process, {
    hideThinking: hideThinking && compactHiddenProcess,
  });

  const defaultOpen = isStreaming
    ? thinkingDisplay !== 'hidden'
    : showFullThinking && !collapseWhenFinished;
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? defaultOpen;
  useEffect(() => {
    setUserOpen(null);
  }, [isStreaming]);

  const now = useLiveNow(isStreaming);
  const streamClockRef = useRef<number | undefined>(undefined);
  if (isStreaming) {
    streamClockRef.current ??= startedAtMs ?? now;
  } else {
    streamClockRef.current = undefined;
  }
  const liveElapsedMs = isStreaming
    ? Math.max(0, now - (startedAtMs ?? streamClockRef.current ?? now))
    : undefined;
  const lastLiveElapsedRef = useRef<number | undefined>(undefined);
  if (isStreaming && liveElapsedMs != null) {
    lastLiveElapsedRef.current = liveElapsedMs;
  }
  const elapsedMs = isStreaming
    ? liveElapsedMs
    : durationMs ?? lastLiveElapsedRef.current;

  const lastProcess = visibleProcess[visibleProcess.length - 1];
  const lastIsReasoning = lastProcess?.type === 'reasoning';
  const reasoningDurationsRef = useRef<number[]>([]);
  const reasoningClockRef = useRef<{ index: number; startedAt: number } | null>(null);
  if (isStreaming && lastIsReasoning) {
    const index = visibleProcess.length - 1;
    if (reasoningClockRef.current?.index !== index) {
      const prev = reasoningClockRef.current;
      if (prev) {
        reasoningDurationsRef.current[prev.index] = Math.max(0, now - prev.startedAt);
      }
      reasoningClockRef.current = { index, startedAt: now };
    }
  } else if (reasoningClockRef.current) {
    const prev = reasoningClockRef.current;
    reasoningDurationsRef.current[prev.index] = Math.max(0, now - prev.startedAt);
    reasoningClockRef.current = null;
  }
  const thinkingElapsedByIndex = visibleProcess.map((block, index) => {
    if (block.type !== 'reasoning') return undefined;
    if (
      isStreaming &&
      lastIsReasoning &&
      index === visibleProcess.length - 1 &&
      reasoningClockRef.current
    ) {
      return Math.max(0, now - reasoningClockRef.current.startedAt);
    }
    return reasoningDurationsRef.current[index];
  });

  if (blocks.length === 0) return <>{emptyFallback}</>;

  const showToggle =
    process.length > 0 &&
    (isStreaming || visibleProcess.length > 0 || !hideThinking || Boolean(processFooter));
  const showProcess = !showToggle || open;
  const showStreamingHint =
    Boolean(streamingHint) && isStreaming && answer.length === 0 && !showToggle;
  const processIsLive = isStreaming && answer.length === 0;
  const lastVisibleIndex = visibleProcess.length - 1;

  return (
    <div className="space-y-1" data-turn-timeline>
      {showToggle && (
        <button
          type="button"
          onClick={() => setUserOpen(!open)}
          className="flex w-full items-center gap-1 py-0.5 text-left text-xs text-agent-muted-foreground transition-colors hover:text-agent-foreground"
          aria-expanded={open}
          data-turn-process=""
          data-testid="turn-process-toggle"
          data-open={open || undefined}
        >
          <span className="min-w-0 truncate">
            {processStatusLabel({
              process: visibleProcess,
              isStreaming,
              elapsedMs,
              hideThinking,
            })}
          </span>
          {open ? (
            <LuChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <LuChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
        </button>
      )}
      {showProcess && (visibleProcess.length > 0 || Boolean(processFooter)) && (
        <div className="space-y-1.5">
          {visibleProcess.map((block, index) => {
            const isLast = index === lastVisibleIndex;
            if (block.type === 'reasoning') {
              const isLive = processIsLive && isLast;
              const elapsed =
                thinkingElapsedByIndex[index] ??
                block.durationMs ??
                (isLive ? undefined : estimateReasoningDurationMs(block.content));
              return (
                <ThinkingFold
                  key={`reasoning-${index}`}
                  content={block.content}
                  label={thinkingFoldLabel({
                    content: block.content,
                    isLive,
                    elapsedMs: elapsed,
                  })}
                  showCursor={isLive}
                  mode={thinkingDisplay}
                  defaultOpen={isLive || !collapseWhenFinished}
                />
              );
            }
            if (block.type === 'tools') {
              return (
                <div key={`tools-${index}`} data-testid="turn-tools">
                  {renderTools(block.actions, index)}
                </div>
              );
            }
            return (
              <div key={`text-${index}`} data-testid="turn-response">
                {renderIntermediateText(block, processIsLive && isLast, index)}
              </div>
            );
          })}
          {processFooter}
        </div>
      )}
      {showStreamingHint ? streamingHint : null}
      {answer.map((block, index) => (
        <Fragment key={`answer-${index}`}>
          {renderAnswer(block, index === answer.length - 1, index)}
        </Fragment>
      ))}
    </div>
  );
}
