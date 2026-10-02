import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { LuArrowDown } from 'react-icons/lu';
import type { ChatMessage } from '@steerable/agent-protocol';
import type { LocalChat, LocalChatAgent, LocalTask } from '@/lib/local-api';
import { t } from '@/i18n';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { InterruptedTurnCard } from './InterruptedTurnCard';
import { TaskOutcomeCards } from './TaskOutcomeCards';
import { SuggestedReplies } from './SuggestedReplies';
import type { ExecutedAction } from './ExecutedActionsCard';
import type { InspectTaskInput } from './executed-actions-model';
import type { ChildInfo } from './OrchestrationChildrenCard';
import type { ChatMode } from './ChatInput';
import type { TurnBlock } from './turn-timeline';
import { followedPreviewPath, type TurnFile } from './turn-files';
import { publishConversationPreview } from '@/layouts/conversation-preview';
import { inferDurationMs, readPersistedDurationMs } from './elapsed';
import type { LlmSpeedSnapshot } from './process-status';

/**
 * MessageList — scrolling viewport that renders user/assistant message
 * bubbles.
 *
 * Tier-1 port of `deeppath`'s MessageList. We kept the visible interaction
 * primitives that matter for parity:
 *   - vertical-scroll container, padding mirrors the cloud product
 *   - sticky-ish "back to bottom" floater that appears when the user scrolls
 *     up during streaming
 *   - empty-state slot
 *   - auto-scroll on new message **only if** the user is already near the
 *     bottom (don't yank focus when they're reading older messages)
 *
 * Intentionally simpler than the original:
 *   - **No per-chat scroll memory across tabs.** Switching chats remounts
 *     this list (parent passes a new `key`), so we don't need the
 *     `chatScrollMemoryRef` machinery.
 *   - **Sticky user-message group per turn.** Grouped turns pin user prompt
 *     cards at the top with `sticky top-0 z-10 bg-agent-canvas/95 backdrop-blur-xs`
 *     until the next turn scrolls into view and naturally pushes it off.
 *   - **No load-more on scroll-up.** Local-backend currently hydrates the
 *     last 200 messages on mount (see `AgentPage.tsx`). Pagination is a
 *     phase-2c follow-up.
 *   - **No turn-process toggle memory.** Expand/collapse of the think+tool
 *     group is per-mount; it resets when the list remounts.
 */

const NEAR_BOTTOM_THRESHOLD_PX = 100;

/** 视口上三分之一附近的助手消息，当作当前正在看的回合。 */
function assistantIdInView(container: HTMLElement): string | null {
  const bounds = container.getBoundingClientRect();
  const anchor = bounds.top + container.clientHeight * 0.35;
  const nodes = container.querySelectorAll<HTMLElement>(
    '[data-message-role="assistant"][data-message-id]',
  );
  let bestId: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom < bounds.top || rect.top > bounds.bottom) continue;
    const distance = Math.abs(rect.top - anchor);
    const messageId = node.getAttribute('data-message-id');
    if (!messageId || distance >= bestDistance) continue;
    bestId = messageId;
    bestDistance = distance;
  }
  return bestId;
}

function internalTrigger(message: ChatMessage): 'goal' | 'loop' | null {
  if (!message.messageMetadata) return null;
  try {
    const metadata = JSON.parse(message.messageMetadata) as {
      internal?: unknown;
      trigger?: unknown;
    };
    if (metadata.internal !== true) return null;
    return metadata.trigger === 'goal' || metadata.trigger === 'loop'
      ? metadata.trigger
      : null;
  } catch {
    return null;
  }
}

interface MessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  emptyState?: ReactNode;
  agents: LocalChatAgent[];
  chats?: LocalChat[];
  /**
   * 当前对话。正文行内代码里的路径按其绑定项目根解析后，确认存在的变成
   * 可点击（见 FilePathCode）。
   */
  chatId?: string | null;
  currentAgent: LocalChatAgent | null;
  /**
   * Tool calls keyed by the persisted message id (post-stream). Used for
   * historical assistant turns where the `executed_actions` event already
   * fired and was reconciled with the DB-assigned message id.
   */
  executedActionsByMessageId?: Record<string, ExecutedAction[]>;
  /**
   * Call-order blocks keyed by persisted message id. Preferred over stacking
   * all tools above the reply when present.
   */
  timelineByMessageId?: Record<string, TurnBlock[]>;
  /** In-flight timeline for the latest assistant turn. */
  currentTurnTimeline?: TurnBlock[];
  /** Epoch ms when the in-flight turn started (Codex elapsed ticker). */
  currentTurnStartedAtMs?: number;
  /** Frozen duration keyed by assistant message id (live freeze + history). */
  durationByMessageId?: Record<string, number>;
  /** Live model-request speed for the in-flight assistant turn. */
  currentLlmSpeed?: LlmSpeedSnapshot;
  /** Frozen model-request speed keyed by assistant message id. */
  llmSpeedByMessageId?: Record<string, LlmSpeedSnapshot>;
  /**
   * 回合产物文件列表，按落库消息 id 键控（live 回合在 message_id 事件时
   * 归档；历史回合从 messageMetadata.turnFiles 水合）。
   */
  turnFilesByMessageId?: Record<string, TurnFile[]>;
  /**
   * 当轮产物文件：turn_files 事件在流尾声到达，此时尾部助手消息仍挂着
   * 占位 id（框架不会在 message_id 后改写它），归档 map 按键查不到——
   * 与 currentTurnActions 同款尾部回退。
   */
  currentTurnFiles?: TurnFile[];
  /**
   * Tool calls accumulated for the in-flight assistant message that the
   * backend hasn't assigned a DB id to yet. Rendered under the latest
   * assistant message while `isStreaming === true`.
   */
  currentTurnActions?: ExecutedAction[];
  /**
   * P3.1 orchestration: live child agents of the in-flight turn (rendered
   * as an OrchestrationPlanCard under the latest assistant message), and
   * the per-message reconciliation map mirroring executedActionsByMessageId.
   */
  currentTurnChildren?: ChildInfo[];
  orchestrationChildrenByMessageId?: Record<string, ChildInfo[]>;
  /**
   * Round counter for the in-flight turn. Forwarded to the tail
   * AssistantMessage so its `StreamingStatus` can show "Round 2 · 继续推理...".
   */
  currentRound?: number;
  /** Current chat mode (Agent / Plan). */
  mode?: ChatMode;
  /** W1.2.1: regenerate an assistant turn (fork-preserving). */
  onRegenerate?: (messageId: string) => Promise<void>;
  /**
   * W7-1: the chat's last turn was interrupted (crash/kill — no completion
   * record). Rendered as a tail card offering to continue the turn; hidden
   * while streaming (a live stream is never interrupted).
   */
  interrupted?: boolean;
  /** W7-1: continue the interrupted turn via the backend resume channel. */
  onContinueInterrupted?: () => void;
  /** W7-1: hide the card for this mount (not persisted). */
  onDismissInterrupted?: () => void;
  /**
   * 本次挂载期间跑完的后台任务（新→旧）——尾部终态通知卡的数据源。
   * 后台任务跑在主对话之外，终态不落消息行，卡片是它回到对话里的唯一位置。
   */
  finishedTasks?: LocalTask[];
  /** 点「查看过程」：在右侧栏打开该任务的推理过程。 */
  onInspectTask?: (task: InspectTaskInput) => void;
  /** 点「忽略」：隐藏这条终态通知（本次挂载内，不落库）。 */
  onDismissFinishedTask?: (taskId: string) => void;
  /** 分享当前对话（截图）。只画在最近一条助手消息的时间戳行上。 */
  onShare?: () => Promise<boolean>;
  /**
   * 最近一条助手回复下的下一轮输入建议（WorkBuddy 式）。只在非流式时渲染。
   */
  suggestedReplies?: string[];
  onSelectSuggestion?: (text: string) => void;
}

export function MessageList({
  messages,
  isStreaming,
  emptyState,
  agents,
  chats = [],
  chatId = null,
  currentAgent,
  executedActionsByMessageId,
  currentTurnActions,
  timelineByMessageId,
  currentTurnTimeline,
  currentTurnStartedAtMs,
  durationByMessageId,
  currentLlmSpeed,
  llmSpeedByMessageId,
  turnFilesByMessageId,
  currentTurnFiles,
  currentTurnChildren,
  orchestrationChildrenByMessageId,
  currentRound,
  mode,
  onRegenerate,
  interrupted = false,
  onContinueInterrupted,
  onDismissInterrupted,
  finishedTasks,
  onInspectTask,
  onDismissFinishedTask,
  onShare,
  suggestedReplies,
  onSelectSuggestion,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);

  const visibleMessages = messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant',
  );
  let lastAssistantId: string | undefined;
  for (let i = visibleMessages.length - 1; i >= 0; i -= 1) {
    if (visibleMessages[i].role === 'assistant') {
      lastAssistantId = visibleMessages[i].id;
      break;
    }
  }

  const checkAtBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD_PX;
    isAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = containerRef.current;
    if (!el) return;
    if (behavior === 'smooth') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('scroll', checkAtBottom, { passive: true });
    return () => {
      el.removeEventListener('scroll', checkAtBottom);
    };
  }, [checkAtBottom]);

  // 右侧预览跟着这一屏在看的回合。停在底部时用最近一份能打开的产物。
  useEffect(() => {
    if (!chatId) return;
    const publish = () => {
      const el = containerRef.current;
      if (!el) return;
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD_PX;
      const ordered = visibleMessages
        .filter((message) => message.role === 'assistant')
        .map((message) => ({
          id: message.id,
          files: message.id === lastAssistantId
            ? (turnFilesByMessageId?.[message.id] ?? currentTurnFiles)
            : turnFilesByMessageId?.[message.id],
        }));
      const selected = followedPreviewPath(ordered, {
        atBottom,
        focusedId: atBottom ? null : assistantIdInView(el),
      });
      if (!selected) return;
      publishConversationPreview({
        chatId,
        messageId: selected.messageId,
        path: selected.path,
      });
    };
    publish();
    const el = containerRef.current;
    el?.addEventListener('scroll', publish, { passive: true });
    return () => {
      el?.removeEventListener('scroll', publish);
    };
  }, [chatId, currentTurnFiles, lastAssistantId, messages, turnFilesByMessageId]);

  // Snap to bottom on first paint, regardless of whether the user "was" at
  // the bottom — there's no "before" on mount.
  useLayoutEffect(() => {
    isAtBottomRef.current = true;
    scrollToBottom('auto');
    setIsAtBottom(true);
  }, [scrollToBottom]);

  // Stick to the bottom *before paint* while the user is still anchored.
  // Smooth `scrollIntoView` on every reasoning token paints a frame mid-list
  // then animates down — on Windows the classic scrollbar visibly jumps.
  const lastMessageId = visibleMessages[visibleMessages.length - 1]?.id;
  const lastContentLen = visibleMessages[visibleMessages.length - 1]?.content?.length ?? 0;
  const lastTimelineSig = currentTurnTimeline
    ?.map((block) => (block.type === 'tools' ? `t${block.actions.length}` : `c${block.content.length}`))
    .join('|') ?? '';
  const suggestedSig = suggestedReplies?.join('\0') ?? '';
  useLayoutEffect(() => {
    if (!isAtBottomRef.current) return;
    scrollToBottom('auto');
  }, [lastMessageId, lastContentLen, lastTimelineSig, suggestedSig, scrollToBottom]);

  // Group consecutive messages into conversation turns.
  // Each turn has an optional user group (1+ consecutive user messages)
  // and zero or more subsequent assistant messages.
  // Grouping into turn containers allows the user prompt to be sticky at
  // the top of the viewport (`sticky top-0`) while scrolling through long
  // assistant reasoning/tools/markdown in that turn, until the next turn
  // scrolls into view and naturally pushes it off.
  type UserGroupItem = { messages: ChatMessage[]; key: string };
  type AssistantItem = { message: ChatMessage; originalIndex: number };
  type ConversationTurn = {
    key: string;
    userGroup?: UserGroupItem;
    assistants: AssistantItem[];
  };

  const conversationTurns = useMemo<ConversationTurn[]>(() => {
    const turns: ConversationTurn[] = [];
    let currentTurn: ConversationTurn | null = null;
    let pendingUserGroup: ChatMessage[] = [];

    for (let i = 0; i < visibleMessages.length; i++) {
      const msg = visibleMessages[i];
      if (msg.role === 'user') {
        if (currentTurn && currentTurn.assistants.length > 0) {
          // Previous turn already has assistant replies; finalize it
          turns.push(currentTurn);
          currentTurn = null;
        }
        pendingUserGroup.push(msg);
      } else {
        if (!currentTurn) {
          currentTurn = {
            key: pendingUserGroup.length > 0
              ? `turn-${pendingUserGroup[0].id}`
              : `turn-head-${msg.id}`,
            userGroup: pendingUserGroup.length > 0
              ? {
                  messages: pendingUserGroup,
                  key: `ug-${pendingUserGroup[0].id}`,
                }
              : undefined,
            assistants: [],
          };
          pendingUserGroup = [];
        }
        currentTurn.assistants.push({ message: msg, originalIndex: i });
      }
    }

    if (pendingUserGroup.length > 0) {
      if (currentTurn) {
        turns.push(currentTurn);
      }
      turns.push({
        key: `turn-${pendingUserGroup[0].id}`,
        userGroup: {
          messages: pendingUserGroup,
          key: `ug-${pendingUserGroup[0].id}`,
        },
        assistants: [],
      });
    } else if (currentTurn) {
      turns.push(currentTurn);
    }

    return turns;
  }, [visibleMessages]);

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={containerRef}
        className="h-full overflow-y-auto overflow-anchor-none px-3 pt-3 pb-6"
      >
        {visibleMessages.length === 0 ? (
          emptyState ?? null
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-4">
            {conversationTurns.map((turn) => (
              <div
                key={turn.key}
                className="conversation-turn relative space-y-4"
                data-conversation-turn={turn.key}
              >
                {turn.userGroup &&
                !turn.userGroup.messages.every((message) => internalTrigger(message) !== null) ? (
                  <div className="sticky top-0 z-10 -mx-3 px-3 py-1 bg-agent-canvas/95 backdrop-blur-xs">
                    {turn.userGroup.messages.length === 1 ? (
                      internalTrigger(turn.userGroup.messages[0]) ? (
                        null
                      ) : (
                        <UserMessage
                          key={turn.userGroup.messages[0].id}
                          message={turn.userGroup.messages[0]}
                          agents={agents}
                          chats={chats}
                        />
                      )
                    ) : (
                      <div
                        key={turn.userGroup.key}
                        className="group/user-group"
                        data-message-role="user-group"
                      >
                        <div className="flex justify-start">
                          <div className="mx-auto w-full max-w-[var(--chat-input-box-width)] overflow-hidden rounded-agent-lg border border-agent-border/80 bg-agent-muted/70 shadow-sm">
                            {turn.userGroup.messages.map((msg, idx) => (
                              internalTrigger(msg) ? (
                                null
                              ) : (
                                <UserMessage
                                  key={msg.id}
                                  message={msg}
                                  agents={agents}
                                  chats={chats}
                                  isGrouped
                                  isAppended={idx > 0}
                                />
                              )
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}

                {turn.assistants.map((item) => {
                  const message = item.message;
                  const isLast = item.originalIndex === visibleMessages.length - 1;
                  // Action attribution: prefer the per-message map (set when the
                  // backend's `message_id` event reconciles the stream-time queue
                  // with the DB id). The framework keeps the in-flight assistant's
                  // placeholder id even after the backend emits `message_id`, so
                  // the current page cannot always key by DB id until reload.
                  // Keep showing `currentTurnActions` on the latest assistant turn
                  // after streaming ends; it is cleared when the next turn starts.
                  const persistedActions =
                    executedActionsByMessageId?.[message.id];
                  const isStreamingTail = isStreaming && isLast;
                  const isCurrentTurnTail =
                    isLast && currentTurnActions !== undefined && currentTurnActions.length > 0;
                  const actions = persistedActions
                    ?? (isStreamingTail || isCurrentTurnTail ? currentTurnActions : undefined);
                  const persistedChildren = orchestrationChildrenByMessageId?.[message.id];
                  const isChildrenTail =
                    isLast && currentTurnChildren !== undefined && currentTurnChildren.length > 0;
                  const childList = persistedChildren
                    ?? (isStreamingTail || isChildrenTail ? currentTurnChildren : undefined);

                  let isPlanMode = false;
                  if (message.messageMetadata) {
                    try {
                      const meta = JSON.parse(message.messageMetadata);
                      if (meta?.mode === 'plan') {
                        isPlanMode = true;
                      }
                    } catch {}
                  } else if (isStreamingTail && mode === 'plan') {
                    isPlanMode = true;
                  }

                  const persistedTimeline = timelineByMessageId?.[message.id];
                  const isCurrentTimelineTail = isLast && currentTurnTimeline !== undefined;
                  const turnTimeline = persistedTimeline
                    ?? (isStreamingTail || isCurrentTimelineTail ? currentTurnTimeline : undefined);

                  const persistedTurnFiles = turnFilesByMessageId?.[message.id];
                  const isTurnFilesTail =
                    isLast && currentTurnFiles !== undefined && currentTurnFiles.length > 0;
                  const turnFiles = persistedTurnFiles
                    ?? (isTurnFilesTail ? currentTurnFiles : undefined);

                  const metadataJson =
                    typeof message.messageMetadata === 'string'
                      ? message.messageMetadata
                      : undefined;
                  let previousUser: ChatMessage | undefined;
                  let previousUserCreatedAt: string | undefined;
                  for (let i = item.originalIndex - 1; i >= 0; i -= 1) {
                    if (visibleMessages[i].role === 'user') {
                      previousUser = visibleMessages[i];
                      previousUserCreatedAt = previousUser.createdAt;
                      break;
                    }
                  }
                  const durationMs = isStreamingTail
                    ? undefined
                    : durationByMessageId?.[message.id]
                      ?? readPersistedDurationMs(metadataJson)
                      ?? inferDurationMs(previousUserCreatedAt, message.createdAt);
                  const persistedSpeed = llmSpeedByMessageId?.[message.id];
                  const isSpeedTail = isLast && currentLlmSpeed !== undefined;
                  const llmSpeed =
                    persistedSpeed
                    ?? (isStreamingTail || isSpeedTail ? currentLlmSpeed : undefined);

                  return (
                    <div key={message.id}>
                      <AssistantMessage
                        message={message}
                        isStreaming={isStreamingTail}
                        agents={agents}
                        chats={chats}
                        chatId={chatId}
                        currentAgent={currentAgent}
                        executedActions={actions}
                        timeline={turnTimeline}
                        orchestrationChildren={childList}
                        previousUser={previousUser}
                        currentRound={isStreamingTail ? currentRound : undefined}
                        isPlanMode={isPlanMode}
                        onRegenerate={onRegenerate}
                        startedAtMs={isStreamingTail ? currentTurnStartedAtMs : undefined}
                        durationMs={durationMs}
                        llmSpeed={llmSpeed}
                        turnFiles={turnFiles}
                        onShare={message.id === lastAssistantId ? onShare : undefined}
                        onInspectTask={onInspectTask}
                      />
                      {!isStreaming &&
                      message.id === lastAssistantId &&
                      suggestedReplies &&
                      suggestedReplies.length > 0 &&
                      onSelectSuggestion ? (
                        <SuggestedReplies
                          suggestions={suggestedReplies}
                          onSelect={onSelectSuggestion}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
            {/* W7-1: 中断提示卡在消息列尾部、与最后一条用户消息同列——
                视觉上隶属于被截断的那一轮，而非全局横幅。流式期间不显示
                （进行中的流不是中断）。 */}
            {interrupted && !isStreaming && onContinueInterrupted && onDismissInterrupted ? (
              <InterruptedTurnCard
                onContinue={onContinueInterrupted}
                onDismiss={onDismissInterrupted}
              />
            ) : null}
            {/* 后台任务终态通知：与中断卡同列在消息列尾部。任务跨 turn 跑，
                结束时间与当前这一轮无关，所以钉在末尾而不是挂到某条消息下。
                流式期间照常显示——任务的结束和主对话在不在说话没有关系。 */}
            {finishedTasks && onInspectTask && onDismissFinishedTask ? (
              <TaskOutcomeCards
                tasks={finishedTasks}
                onInspect={onInspectTask}
                onDismiss={onDismissFinishedTask}
              />
            ) : null}
          </div>
        )}
      </div>

      {!isAtBottom && visibleMessages.length > 0 && (
        <button
          type="button"
          onClick={() => {
            isAtBottomRef.current = true;
            setIsAtBottom(true);
            scrollToBottom('smooth');
          }}
          className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-full border border-agent-border bg-agent-canvas text-agent-foreground shadow-md transition-colors hover:bg-agent-foreground/5"
          title={t('Back to bottom')}
          aria-label={t('Back to bottom')}
        >
          <LuArrowDown className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export default MessageList;
