import type { ReactNode } from 'react';
import type { LocalChat, LocalChatAgent } from '@/lib/local-api';
import type { ThinkingDisplayMode } from '@/lib/show-thinking-content';
import { Markdown } from './Markdown';
import { ToolsFlow } from './ExecutedActionsCard';
import type { InspectTaskInput } from './executed-actions-model';
import type { ChildInfo } from './OrchestrationChildrenCard';
import { OrchestrationChildrenCard } from './OrchestrationChildrenCard';
import { TurnUsageLine } from './TurnUsageLine';
import type { TurnUsage } from './turn-usage';
import type { TurnBlock } from './turn-timeline';
import {
  THINKING_PEEK_HEIGHT,
  THINKING_PEEK_LINES,
  TurnProcessTimeline,
} from './TurnProcessTimeline';

/**
 * Codex / DeepSeek-style turn process. Each LLM round keeps three surfaces
 * distinct: 思考 (muted CoT), 思考后的 response (reply bubble), 工具
 * (cards). Trailing text becomes 最后一次结论 only after the stream ends —
 * promoting it earlier would restyle it as thinking when the next round
 * starts. Settings 「显示思考内容」 only clip the 思考正文: hidden /
 * 5-line peek / full. A finished 思考 fold auto-collapses in chat;
 * only the live round stays open. Tools and the work row stay independent.
 */

export { THINKING_PEEK_HEIGHT, THINKING_PEEK_LINES };

export function TurnProcessGroup({
  blocks,
  isStreaming,
  agents,
  chats,
  chatId,
  onInspectTask,
  orchestrationChildren,
  onContinueChild,
  onStopChild,
  turnUsage,
  emptyFallback,
  streamingHint,
  startedAtMs,
  durationMs,
  thinkingDisplay,
  showThinkingContent,
  collapseWhenFinished = true,
  renderAnswer,
}: {
  blocks: TurnBlock[];
  isStreaming: boolean;
  agents: LocalChatAgent[];
  chats: LocalChat[];
  chatId?: string | null;
  onInspectTask?: (task: InspectTaskInput) => void;
  /** 本回合子代理：委派行据此跳转到子代理过程。 */
  orchestrationChildren?: ChildInfo[];
  /** 「继续」一个已可续的子代理（R7）。 */
  onContinueChild?: (childId: string, recordId: string) => void;
  /** 「停止」一个正在跑的子代理（R7）。 */
  onStopChild?: (childId: string) => void;
  /** R6：本回合账单（父级 + 子代理合计），画在子代理看板下方。 */
  turnUsage?: TurnUsage;
  emptyFallback: ReactNode;
  /** Shown while streaming after a tools row and before the summary lands. */
  streamingHint?: ReactNode;
  /** Epoch ms when this turn started — live ticker while `isStreaming`. */
  startedAtMs?: number;
  /** Frozen wall-clock of a finished turn (metadata or just-ended stream). */
  durationMs?: number;
  /** Override the settings preference (hidden / peek / full). */
  thinkingDisplay?: ThinkingDisplayMode;
  /**
   * Legacy override. `true` = full, `false` = peek.
   * Task process panel passes true so the inspector stays expanded.
   */
  showThinkingContent?: boolean;
  /**
   * After the stream ends, fold the work row to the summary line.
   * Task inspector sets false so the replay stays open.
   */
  collapseWhenFinished?: boolean;
  renderAnswer: (block: Extract<TurnBlock, { type: 'text' }>, isLast: boolean) => ReactNode;
}) {
  const hasChildrenCard = (orchestrationChildren?.length ?? 0) >= 2;
  const processFooter =
    hasChildrenCard || Boolean(turnUsage) ? (
      <>
        {/* R7 子代理看板：挂在过程块之后、正文之前。≥2 个子代理才渲染，
            单次委派已在工具行里有同一条进度。 */}
        <OrchestrationChildrenCard
          children={orchestrationChildren ?? []}
          agents={agents}
          onContinue={onContinueChild}
          onStop={onStopChild}
        />
        {/* R6 回合账单：紧随看板，读的是「父级 + 子代理」的整份数字。 */}
        <TurnUsageLine usage={turnUsage} />
      </>
    ) : undefined;

  return (
    <TurnProcessTimeline
      blocks={blocks}
      isStreaming={isStreaming}
      startedAtMs={startedAtMs}
      durationMs={durationMs}
      thinkingDisplay={thinkingDisplay}
      showThinkingContent={showThinkingContent}
      collapseWhenFinished={collapseWhenFinished}
      emptyFallback={emptyFallback}
      streamingHint={streamingHint}
      processFooter={processFooter}
      renderTools={(actions) => (
        <ToolsFlow
          actions={actions}
          compact
          agents={agents}
          chatId={chatId}
          onInspectTask={onInspectTask}
          orchestrationChildren={orchestrationChildren}
        />
      )}
      renderIntermediateText={(block, isLiveLast) => (
        <div>
          <div className="markdown-content text-xs leading-relaxed text-agent-foreground">
            <Markdown agents={agents} chats={chats} chatId={chatId}>
              {block.content}
            </Markdown>
          </div>
          {isLiveLast ? (
            <span className="ml-0.5 inline-block h-3.5 w-[3px] animate-agent-cursor-blink bg-agent-foreground/60 align-text-bottom" />
          ) : null}
        </div>
      )}
      renderAnswer={(block, isLast) => renderAnswer(block, isLast)}
    />
  );
}
