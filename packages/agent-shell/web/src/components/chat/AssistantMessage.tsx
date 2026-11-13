import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  LuCheck,
  LuChevronDown,
  LuChevronUp,
  LuCopy,
  LuListChecks,
  LuLoaderCircle,
  LuRefreshCw,
  LuShare2,
  LuTriangleAlert,
} from 'react-icons/lu';
import type { ChatMessage } from '@steerable/agent-protocol';
import type { LocalChat, LocalChatAgent } from '@/lib/local-api';
import { t } from '@/i18n';
import { Markdown } from './Markdown';
import { ExecutedActionsCard, type ExecutedAction } from './ExecutedActionsCard';
import type { ChildInfo } from './OrchestrationChildrenCard';
import { collectTurnParticipants, extractMentionedAgentIds } from './executed-actions-model';
import type { InspectTaskInput } from './executed-actions-model';
import { StreamingStatus } from './StreamingStatus';
import { TurnFailureCard, type TurnFailureCardProps } from './TurnFailureCard';
import { readFailureDetail, type TurnFailureDetail } from './turn-failure';
import type { RetryState } from './RetryStatus';
import { getFriendlyDate } from './timestamp';
import { useCopy } from './useCopy';
import type { TurnBlock } from './turn-timeline';
import { TurnProcessGroup } from './TurnProcessGroup';
import { TurnFilesCard } from './TurnFilesCard';
import type { TurnFile } from './turn-files';
import type { TurnUsage } from './turn-usage';
import { stripNextStepsTags } from './next-steps-tags';
import {
  formatTokenSpeed,
  llmRequestElapsedMs,
  type LlmSpeedSnapshot,
} from './process-status';

/**
 * AssistantMessage — Tier-1 port of `deeppath`'s assistant-bubble.
 *
 * **Covered**:
 *   - Left-aligned bubble flush with user bubbles (no right-align).
 *   - Agent badge at top showing the agent that authored this message
 *     (color dot + name). Historical messages trust `message.agentId`; the
 *     in-flight tail message falls back to `currentAgent` so the badge shows
 *     up the moment streaming starts (before the DB row gets flushed).
 *   - Turn timeline (reasoning / tool cards / reply text in call order)
 *     reconstructed from the SSE stream. After the trailing summary lands,
 *     think+tool steps collapse into one disclosure (Codex / DeepSeek
 *     turn-process). Legacy messages without a timeline still render the
 *     grouped `ExecutedActionsCard` above the body.
 *   - Markdown body (gfm tables, raw html via the shared `Markdown` helper).
 *   - `StreamingStatus` while in-flight + no content yet — escalates the
 *     label based on round / action count so multi-round runs don't feel
 *     stuck.
 *   - Streaming cursor blink at the tail of the rendered content.
 *   - Hover-revealed copy button + friendly timestamp at bottom-left.
 *
 * **Not here yet** (depends on local-backend emitting structured segments):
 *   - `PlanSteps` / `PlanSelector` / `ResearchPlan` /
 *     `AnalysisDocument` / `QuizCard` / `CoverageReport`. These come from
 *     the cloud product's content-segment pipeline.
 *   - `ActionRenderer` (Goal/Task/Event/Resource/Automation update cards).
 *     Skip per the project's "agent-only" charter (no business entities).
 *   - `SearchSources` (web-search source list under the bubble). Local
 *     agent doesn't run web search in the cloud sense.
 */

interface AssistantMessageProps {
  message: ChatMessage;
  /** True iff this is the most recent message AND the stream is still open. */
  isStreaming: boolean;
  /**
   * Lookup table for agent metadata. The bubble shows the color dot + name
   * for the agent that authored this turn. When the message itself doesn't
   * carry `agentId` (historical / builtin / not-yet-flushed during streaming)
   * we fall back to `currentAgent`.
   */
  agents: LocalChatAgent[];
  chats?: LocalChat[];
  /**
   * 当前对话。正文行内代码里的路径按它绑定的项目根解析相对路径后，
   * 确认存在的会变成可点击（见 FilePathCode）。
   */
  chatId?: string | null;
  /** Active chat-level agent — used as a fallback during streaming. */
  currentAgent: LocalChatAgent | null;
  /**
   * Tool calls that ran during this assistant turn (emitted by local-backend
   * via the `executed_actions` SSE event). On the legacy path they render
   * as a grouped card above the body. With a `timeline` they sit inside the
   * foldable think→act process. Empty / undefined => hidden.
   */
  executedActions?: ExecutedAction[];
  /**
   * Call-order blocks for this turn (reasoning → tools → text). When present
   * the bubble renders them interleaved; otherwise `executedActions` +
   * `content` keep the legacy stacked layout.
   */
  timeline?: TurnBlock[];
  /**
   * P3.1 子代理生命周期。看板卡片已不再渲染——每个 `委派 · X` 工具行从
   * 「执行中」到「已完成」本身就是同一份进度，还能展开看任务书与回报。
   * 这份列表现在喂两处：顶栏参与者徽章（没有 `@提及` 时的回落来源），
   * 以及委派行跳转右侧过程栏所需的子代理 record。
   */
  orchestrationChildren?: ChildInfo[];
  /** 上一轮用户消息：顶栏按里面的 `@提及` 画参与的智能体。 */
  previousUser?: Pick<ChatMessage, 'content'> & { messageMetadata?: string | null };
  /**
   * Current round number for the in-flight turn (1-based). Only meaningful
   * when `isStreaming === true` and this is the tail message — used by
   * `StreamingStatus` to render "Round 2 · 继续推理..." between LLM bursts.
   */
  currentRound?: number;
  /**
   * Live retry state of the in-flight request. While set, the status line
   * says "reconnecting" instead of "thinking": a seconds-scale backoff and a
   * stalled request look the same without it.
   */
  retryState?: RetryState | null;
  /** True iff the message was generated in Plan mode. */
  isPlanMode?: boolean;
  /**
   * W1.2.1: regenerate this assistant turn (non-destructive — the old tail
   * is forked into a branch by the backend). When provided, a hover action
   * appears next to copy. The promise resolves when the regenerated turn
   * has fully streamed; the caller then re-hydrates the message list.
   */
  onRegenerate?: (messageId: string) => Promise<void>;
  /**
   * Resolves a failed turn's action into a handler. The message list decides
   * what this build can do (Continue needs a backend route, opening settings
   * needs the modal); the card only draws what it is given.
   */
  failureAction?: TurnFailureCardProps['action'];
  /** Epoch ms when this turn started — live ticker while streaming. */
  startedAtMs?: number;
  /** Frozen wall-clock of a finished turn. */
  durationMs?: number;
  /**
   * Model-request generation speed (reasoning + reply + any other LLM
   * output). Elapsed excludes tool waits. Live snapshots keep ticking
   * while `live` is true.
   */
  llmSpeed?: LlmSpeedSnapshot;
  /**
   * 本回合产生/修改的文件列表（local-backend 回合收尾时收集，经
   * `turn_files` SSE + messageMetadata.turnFiles 持久化）。渲染在回答
   * 气泡之下，点击用系统默认应用打开。空/undefined = 不渲染。
   */
  turnFiles?: TurnFile[];
  /**
   * R6：本回合的账单（local-backend 把 sidecar 的 `stream.done.usage` 经
   * `turn_usage` SSE + messageMetadata.usage 落库）。面板据此显示「这一轮
   * 花了多少、其中子代理占多少」；父级自己的花费不在任何子代理行里，
   * 所以这份数据没有替代品。
   */
  turnUsage?: TurnUsage;
  /**
   * 分享当前对话（截图复制到剪贴板）。只传给最近一条助手消息，画在时间戳
   * 行上，跟复制 / 重新生成同一排。
   */
  onShare?: () => Promise<boolean>;
  onInspectTask?: (task: InspectTaskInput) => void;
  /** R7：子代理面板的「继续」/「停止」。 */
  onContinueChild?: (childId: string, recordId: string) => void;
  onStopChild?: (childId: string) => void;
}

function agentInitial(name: string): string {
  return name.trim()[0]?.toUpperCase() ?? 'A';
}

function AgentBadge({
  name,
  color,
  title,
  isStreaming,
}: {
  name: string;
  color: string;
  title?: string;
  isStreaming?: boolean;
}) {
  return (
    <div
      className="inline-flex items-center gap-1.5 text-[11px] leading-none text-agent-muted-foreground"
      title={title || name}
    >
      <span
        data-agent-color-dot=""
        className="inline-flex items-center justify-center rounded-full text-[9px] font-semibold text-white"
        style={{
          width: 14,
          height: 14,
          backgroundColor: color,
        }}
      >
        {agentInitial(name)}
      </span>
      <span className="max-w-[160px] truncate rounded bg-agent-canvas/90 px-1">
        {name}
      </span>
      {isStreaming && (
        <span className="ml-1 inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-agent-foreground/30" />
      )}
    </div>
  );
}

const META_ACTION =
  'inline-flex items-center gap-0.5 rounded transition-all duration-200 hover:text-agent-foreground opacity-0 focus:opacity-100 group-hover/message:opacity-100';

function bubbleClass(isPlanMode: boolean): string {
  return isPlanMode ? 'rounded-agent-lg bg-amber-50/10 dark:bg-amber-950/5' : '';
}

// 框架 useChatStream 收到 SSE error 事件时把最后一条助手消息的内容打成
// "[stream error] ..."（live 路径）；落库后失败原因在
// messageMetadata.completionReason（刷新/重载路径，可能还留着部分正文）。
// 两处汇合到同一个错误气泡，失败回合不再只显示"（空消息）"。
const STREAM_ERROR_PREFIX = '[stream error] ';

interface TurnFailure {
  reason: string;
  contentIsError: boolean;
  /** Classified detail; undefined for live stream errors and old records. */
  detail?: TurnFailureDetail;
  traceId?: string;
}

/**
 * Terminal state of a persisted turn, for the card it should show.
 *
 * `failed` and `cancelled` are different for the reader even though both can
 * be continued: one is the network's fault and comes back as a failure card,
 * the other is the user's own Stop and reads as a neutral notice. Absent
 * metadata means the turn finished normally (older records carry no status).
 */
/**
 * Whether this failed/stopped turn was continued afterwards.
 *
 * The host stamps `continuedAt` when a resume starts from this turn. The card
 * then collapses into one line: the failure is history the user already acted
 * on, and re-showing the full card after a reload would read as "it failed
 * again". Expanding it still yields the original diagnostics.
 */
function readContinued(message: ChatMessage): boolean {
  const raw = (message as { messageMetadata?: unknown }).messageMetadata;
  if (typeof raw !== 'string' || !raw) return false;
  try {
    const at = (JSON.parse(raw) as { continuedAt?: unknown }).continuedAt;
    return typeof at === 'string' && at.length > 0;
  } catch {
    return false;
  }
}

/** True when the user's Stop landed while a retry was pending. */
function readStoppedDuringRetry(message: ChatMessage): boolean {
  const raw = (message as { messageMetadata?: unknown }).messageMetadata;
  if (typeof raw !== 'string' || !raw) return false;
  try {
    const reason = (JSON.parse(raw) as { completionReason?: unknown }).completionReason;
    return reason === 'aborted_during_retry';
  } catch {
    return false;
  }
}

function readTurnStatus(message: ChatMessage): 'failed' | 'cancelled' | 'completed' {
  const raw = (message as { messageMetadata?: unknown }).messageMetadata;
  if (typeof raw !== 'string' || !raw) return 'completed';
  try {
    const status = (JSON.parse(raw) as { completionStatus?: unknown }).completionStatus;
    if (status === 'failed') return 'failed';
    if (status === 'cancelled') return 'cancelled';
    return 'completed';
  } catch {
    // 元数据损坏按正常完成处理——落回原有的空消息展示。
    return 'completed';
  }
}

function readTurnFailure(message: ChatMessage, content: string): TurnFailure | null {
  if (content.startsWith(STREAM_ERROR_PREFIX)) {
    // Live path: the framework stamped the reason into the content before the
    // turn was persisted, so nothing structured is available yet.
    return { reason: content.slice(STREAM_ERROR_PREFIX.length), contentIsError: true };
  }
  const raw = (message as { messageMetadata?: unknown }).messageMetadata;
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const meta = JSON.parse(raw) as {
      completionStatus?: unknown;
      completionReason?: unknown;
      failure?: unknown;
      traceId?: unknown;
    };
    if (
      meta?.completionStatus === 'failed' &&
      typeof meta.completionReason === 'string' &&
      meta.completionReason
    ) {
      return {
        reason: meta.completionReason,
        contentIsError: false,
        detail: readFailureDetail(meta.failure),
        traceId: typeof meta.traceId === 'string' && meta.traceId ? meta.traceId : undefined,
      };
    }
  } catch {
    // 元数据损坏按无失败处理——落回原有的空消息展示。
  }
  return null;
}

function readPersistedAgentId(message: ChatMessage): string | undefined {
  const raw = (message as { messageMetadata?: unknown }).messageMetadata;
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const agentId = (JSON.parse(raw) as { agentId?: unknown }).agentId;
    return typeof agentId === 'string' && agentId ? agentId : undefined;
  } catch {
    return undefined;
  }
}

function TurnErrorBubble({
  failure,
  completedSteps,
  happenedAt,
  onAction,
}: {
  failure: TurnFailure;
  completedSteps: number;
  happenedAt?: string;
  onAction?: TurnFailureCardProps['action'];
}) {
  return (
    <TurnFailureCard
      detail={failure.detail}
      reason={failure.reason}
      completedSteps={completedSteps}
      happenedAt={happenedAt}
      traceId={failure.traceId}
      action={onAction}
    />
  );
}

/**
 * One collapsed line standing in for a failure the user already continued.
 *
 * It stays expandable rather than disappearing: the diagnostics are the only
 * record of what went wrong, and someone filing a report a day later still
 * needs them. The default is collapsed so a resumed conversation reads as
 * continuous work rather than a stack of past failures.
 */
function ContinuedHereLine({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="continued-here">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[11px] text-agent-muted-foreground hover:text-agent-foreground"
        data-action="continued-here"
      >
        <LuTriangleAlert className="h-3 w-3" />
        {t('Connection failed here. Continued.')}
        {open ? <LuChevronUp className="h-3 w-3" /> : <LuChevronDown className="h-3 w-3" />}
      </button>
      {open ? <div className="mt-1.5">{children}</div> : null}
    </div>
  );
}

/**
 * Neutral notice for a turn the user stopped.
 *
 * Deliberately not the failure card: nothing went wrong, the user chose to
 * stop. It still offers Continue, because the usual reason to stop a turn is
 * impatience with a retry, and the work done so far is worth keeping. The copy
 * distinguishes a stop during reconnection — the case where "continue" is
 * almost certainly wanted — from a stop while the model was writing.
 */
function TurnStoppedCard({
  duringRetry,
  action,
}: {
  duringRetry: boolean;
  action?: TurnFailureCardProps['action'];
}) {
  const handler = action?.({ kind: 'retry' }) ?? null;
  return (
    <div
      className="rounded-agent-lg border border-agent-border bg-agent-muted/40 px-2.5 py-2 text-xs leading-relaxed"
      data-testid="turn-stopped"
    >
      <div className="flex items-start gap-2 font-medium text-agent-foreground">
        <span className="mt-[3px] h-2 w-2 flex-shrink-0 rounded-[2px] bg-agent-muted-foreground" />
        <span>{t('Stopped')}</span>
      </div>
      <p className="mt-1 ml-5 text-agent-muted-foreground">
        {duringRetry
          ? t('You stopped this task while it was reconnecting.')
          : t('You stopped this task.')}
      </p>
      {handler ? (
        <div className="mt-2 ml-5">
          <button
            type="button"
            disabled={handler.disabled}
            title={handler.hint}
            onClick={handler.onClick}
            className="rounded-agent-md border border-agent-border bg-agent-card px-3 py-1 text-xs text-agent-foreground transition hover:bg-agent-muted disabled:opacity-50"
            data-action="continue"
          >
            {t('Continue')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function StreamingCursor() {
  return (
    <span className="ml-0.5 inline-block h-3.5 w-[3px] animate-agent-cursor-blink bg-agent-foreground/60 align-text-bottom" />
  );
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

export function AssistantMessage({
  message,
  isStreaming,
  agents,
  chats = [],
  chatId = null,
  currentAgent,
  executedActions,
  timeline,
  orchestrationChildren,
  previousUser,
  currentRound = 1,
  retryState,
  isPlanMode = false,
  onRegenerate,
  failureAction,
  startedAtMs,
  durationMs,
  llmSpeed,
  turnFiles,
  turnUsage,
  onShare,
  onInspectTask,
  onContinueChild,
  onStopChild,
}: AssistantMessageProps) {
  const content = message.content || '';
  const failure = readTurnFailure(message, content);
  const stopped = !failure && readTurnStatus(message) === 'cancelled';
  const stoppedDuringRetry = stopped && readStoppedDuringRetry(message);
  const continued = readContinued(message);
  // live 错误文本（"[stream error] ..."）不当正文渲染；落库的失败回合可能
  // 留有部分正文，此时正文与错误气泡都展示。
  const displayContent = failure?.contentIsError ? '' : content;
  const { copied, copy } = useCopy(stripNextStepsTags(content));
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const persistedAgentId =
    typeof message.agentId === 'string' && message.agentId
      ? message.agentId
      : readPersistedAgentId(message);
  const persistedAgent = persistedAgentId
    ? agents.find((a) => a.id === persistedAgentId) ?? null
    : null;
  // Stream-time fallback: only allow the chat-level agent to "claim" a turn
  // while it's actively streaming and hasn't flushed agentId to the DB yet.
  const displayAgent = persistedAgent ?? (isStreaming ? currentAgent : null);
  const useTimeline = timeline !== undefined;
  const blocks = timeline ?? [];
  const toolActions = [
    ...(executedActions ?? []),
    ...blocks.flatMap((block) => (block.type === 'tools' ? block.actions : [])),
  ];
  const participants = collectTurnParticipants(displayAgent, {
    agents,
    children: orchestrationChildren,
    actions: toolActions,
    mentionedAgentIds: extractMentionedAgentIds(previousUser, agents),
  });
  const now = useLiveNow(Boolean(isStreaming && llmSpeed?.live));
  const tokenSpeed = formatTokenSpeed(
    llmSpeed?.tokens ?? 0,
    llmRequestElapsedMs(llmSpeed, now),
  );

  // A continued failure renders as one line; expanding it yields the card.
  const wrapContinued = (card: React.ReactNode) =>
    continued ? <ContinuedHereLine>{card}</ContinuedHereLine> : card;

  return (
    <motion.div
      className="group/message"
      data-message-role="assistant"
      data-message-id={message.id}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      <div className="mx-auto w-full max-w-[var(--chat-input-box-width)] px-1">
        {(participants.length > 0 || isPlanMode) && (
          <div className="mb-1 flex min-h-4 items-center justify-between gap-2">
            {participants.length > 0 ? (
              <div
                data-testid="turn-agent-badges"
                className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
              >
                {participants.map((agent, index) => (
                  <AgentBadge
                    key={agent.key}
                    name={agent.name}
                    color={agent.color}
                    isStreaming={isStreaming && index === 0}
                  />
                ))}
              </div>
            ) : (
              <div />
            )}
            {isPlanMode && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 dark:border-amber-800/50 bg-amber-100/70 dark:bg-amber-900/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300 select-none">
                <LuListChecks className="h-3.5 w-3.5" />
                <span>{t('Plan mode (Plan)')}</span>
              </span>
            )}
          </div>
        )}
        {useTimeline ? (
          <>
          <TurnProcessGroup
            blocks={blocks}
            isStreaming={isStreaming}
            startedAtMs={startedAtMs}
            durationMs={durationMs}
            agents={agents}
            chats={chats}
            chatId={chatId}
            onInspectTask={onInspectTask}
            orchestrationChildren={orchestrationChildren}
            turnUsage={turnUsage}
            onContinueChild={onContinueChild}
            onStopChild={onStopChild}
            emptyFallback={
              failure ? (
                wrapContinued(
                  <TurnErrorBubble
                    failure={failure}
                    completedSteps={toolActions.length}
                    happenedAt={message.createdAt}
                    onAction={failureAction}
                  />,
                )
              ) : isStreaming ? (
                <div className={bubbleClass(isPlanMode)}>
                  <StreamingStatus
                    round={currentRound}
                    actionCount={executedActions?.length ?? 0}
                    hasContent={false}
                    retry={retryState ?? undefined}
                  />
                </div>
              ) : stopped ? (
                <TurnStoppedCard duringRetry={stoppedDuringRetry} action={failureAction} />
              ) : (
                <div className={`${bubbleClass(isPlanMode)} text-xs italic text-agent-muted-foreground`}>
                  {t('(empty message)')}
                </div>
              )
            }
            streamingHint={
              <StreamingStatus
                round={currentRound}
                actionCount={executedActions?.length ?? 0}
                hasContent={false}
                retry={retryState ?? undefined}
              />
            }
            renderAnswer={(block, isLast) => (
              <div className={bubbleClass(isPlanMode)}>
                <div className="markdown-content text-xs leading-relaxed text-agent-foreground">
                  <Markdown agents={agents} chats={chats} chatId={chatId}>{block.content}</Markdown>
                </div>
                {isStreaming && isLast && <StreamingCursor />}
              </div>
            )}
          />
          {/* 有部分正文/工具块但回合失败：正文照常渲染，错误气泡补在下方
              （无块时走上面的 emptyFallback，不会重复）。 */}
          {failure && blocks.length > 0 ? (
            <div className="mt-1.5">
              {wrapContinued(
                <TurnErrorBubble
                  failure={failure}
                  completedSteps={toolActions.length}
                  happenedAt={message.createdAt}
                  onAction={failureAction}
                />,
              )}
            </div>
          ) : null}
          {stopped && blocks.length > 0 ? (
            <div className="mt-1.5">
              <TurnStoppedCard duringRetry={stoppedDuringRetry} action={failureAction} />
            </div>
          ) : null}
          </>
        ) : (
          <>
            {executedActions && executedActions.length > 0 && (
              <ExecutedActionsCard
                actions={executedActions}
                agents={agents}
                chatId={chatId}
                onInspectTask={onInspectTask}
                orchestrationChildren={orchestrationChildren}
              />
            )}
            {displayContent ? (
              <div className={bubbleClass(isPlanMode)}>
                <div className="markdown-content text-xs leading-relaxed text-agent-foreground">
                  <Markdown agents={agents} chats={chats} chatId={chatId}>{displayContent}</Markdown>
                </div>
                {isStreaming && <StreamingCursor />}
              </div>
            ) : failure ? (
              wrapContinued(
                <TurnErrorBubble
                  failure={failure}
                  completedSteps={toolActions.length}
                  happenedAt={message.createdAt}
                  onAction={failureAction}
                />,
              )
            ) : isStreaming ? (
              <div className={bubbleClass(isPlanMode)}>
                <StreamingStatus
                  round={currentRound}
                  actionCount={executedActions?.length ?? 0}
                  hasContent={false}
                  retry={retryState ?? undefined}
                />
              </div>
            ) : stopped ? (
              <TurnStoppedCard duringRetry={stoppedDuringRetry} action={failureAction} />
            ) : (
              <div className={`${bubbleClass(isPlanMode)} text-xs italic text-agent-muted-foreground`}>
                {t('(empty message)')}
              </div>
            )}
            {displayContent && failure ? (
              <div className="mt-1.5">
                {wrapContinued(
                  <TurnErrorBubble
                    failure={failure}
                    completedSteps={toolActions.length}
                    happenedAt={message.createdAt}
                    onAction={failureAction}
                  />,
                )}
              </div>
            ) : null}
          </>
        )}
        {/* 回合产物文件列表：钉在回答之下、时间戳行之上（Codex 式收尾）。
            回合收尾才有数据，流式期间天然为空。 */}
        {!isStreaming && turnFiles && turnFiles.length > 0 && (
          <div className="mt-2.5 mb-1">
            <TurnFilesCard files={turnFiles} executedActions={executedActions} chatId={chatId} />
          </div>
        )}
        <div className="mt-2 flex items-center gap-2 text-[11px] text-agent-muted-foreground/80">
          <span>
            {message.createdAt
              ? getFriendlyDate(new Date(message.createdAt))
              : ''}
          </span>
          {tokenSpeed ? (
            <span data-testid="turn-token-speed">{tokenSpeed}</span>
          ) : null}
          {content && !isStreaming && (
            <button
              type="button"
              onClick={() => void copy()}
              className={META_ACTION}
              title={copied ? t('Copied') : t('Copy message')}
              aria-label={copied ? t('Copied') : t('Copy message')}
            >
              {copied ? (
                <>
                  <LuCheck className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-emerald-600 dark:text-emerald-400">
                    {t('Copied')}
                  </span>
                </>
              ) : (
                <LuCopy className="h-3 w-3" />
              )}
            </button>
          )}
          {/* Regenerate is offered for a failed or stopped turn even when it
              produced no text: the reply the user wanted is missing, and
              regenerating from the turn's start is the alternative to
              Continue when Continue is not the right answer. */}
          {(content || failure || stopped) && !isStreaming && onRegenerate && (
            <button
              type="button"
              disabled={regenerating}
              onClick={() => {
                if (regenerating) return;
                setRegenerating(true);
                setRegenerateError(null);
                onRegenerate(message.id)
                  // The backend refuses when it could not preserve this reply
                  // as a branch. Dropping that leaves the spinner stopping for
                  // no stated reason while the reply sits unchanged.
                  .catch((err: unknown) =>
                    setRegenerateError(
                      err instanceof Error ? err.message : String(err),
                    ),
                  )
                  .finally(() => setRegenerating(false));
              }}
              className={`${META_ACTION} disabled:cursor-not-allowed`}
              title={
                regenerating
                  ? t('Regenerating...')
                  : t('Regenerate (start this turn over; the old reply is kept as a branch)')
              }
              aria-label={regenerating ? t('Regenerating') : t('Regenerate')}
              data-action="regenerate"
            >
              <LuRefreshCw
                className={`h-3 w-3 ${regenerating ? 'animate-spin' : ''}`}
              />
            </button>
          )}
          {onShare && !isStreaming && <ShareChatButton onShare={onShare} />}
        </div>
        {regenerateError && (
          <div
            className="mt-1 text-[11px] text-amber-700 dark:text-amber-400"
            role="status"
            data-regenerate-error
          >
            {regenerateError}
          </div>
        )}
      </div>
    </motion.div>
  );
}

export default AssistantMessage;

function ShareChatButton({ onShare }: { onShare: () => Promise<boolean> }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    },
    [],
  );

  return (
    <button
      type="button"
      disabled={state === 'busy'}
      onClick={() => {
        if (state === 'busy') return;
        setState('busy');
        void (async () => {
          let ok = false;
          try {
            ok = await onShare();
          } catch {
            ok = false;
          }
          setState(ok ? 'done' : 'error');
          if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
          resetTimerRef.current = setTimeout(() => setState('idle'), 2000);
        })();
      }}
      className={`${META_ACTION} disabled:cursor-not-allowed ${
        state === 'done'
          ? 'text-emerald-600 dark:text-emerald-400'
          : state === 'error'
            ? 'text-agent-destructive'
            : ''
      }`}
      title={
        state === 'done'
          ? t('Screenshot copied to clipboard')
          : state === 'error'
            ? t('Screenshot failed. Try again.')
            : t('Share chat (copy a screenshot to the clipboard)')
      }
      aria-label={t('Share chat screenshot')}
    >
      {state === 'busy' ? (
        <LuLoaderCircle className="h-3 w-3 animate-spin" />
      ) : state === 'done' ? (
        <LuCheck className="h-3 w-3" />
      ) : (
        <LuShare2 className="h-3 w-3" />
      )}
    </button>
  );
}
