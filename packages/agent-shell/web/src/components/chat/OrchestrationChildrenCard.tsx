import { useMemo } from 'react';
import {
  OrchestrationPlanCard,
  ORCHESTRATION_DOT_CLASS,
  ORCHESTRATION_STATUS_LABEL,
  type OrchestrationTaskStatus,
} from '@steerable/agent-ui/cards';
import {
  childrenToCardModel,
  findAgentForProfile,
  isChildResumable,
  shouldShowOrchestrationBoard,
  type ChildInfo,
} from './orchestration-children-model';
import type { LocalChatAgent } from '@/lib/local-api';
import { t } from '@/i18n';

/**
 * OrchestrationChildrenCard — the desktop surface of the framework's
 * multi-agent layer (R7). Adapts the live `ChildInfo` list (accumulated from
 * `orchestration_child` SSE events) onto the framework's
 * `OrchestrationPlanCard`: one row per child, with the profile, depth, status,
 * token bill, elapsed time and the row's two actions.
 *
 * The card payload is synthesized from lifecycle events, so there is no
 * separate "plan" step: the plan IS the set of spawned children.
 *
 * Rows are overridden (`renderTaskRow`) because the shape the card renders by
 * default (a task list) is not what a sub-agent is: this row carries a
 * lifetime measurement and a resume action, neither of which a plan task has.
 *
 * The mapping logic lives in `./orchestration-children-model` (pure,
 * runtime-dependency-free) so node-side tests do not pull the agent-ui dist
 * build.
 */

export type { ChildInfo } from './orchestration-children-model';

export function OrchestrationChildrenCard({
  children,
  agents = [],
  onViewProcess,
  onContinue,
  onStop,
}: {
  children: ChildInfo[];
  agents?: ReadonlyArray<Pick<LocalChatAgent, 'id' | 'slug' | 'name' | 'color'>>;
  /** 「查看过程」— opens the child's own record in the process panel. */
  onViewProcess?: (recordId: string) => void;
  /** 「继续」— resumes an interrupted or budget-stopped child. */
  onContinue?: (childId: string, recordId: string) => void;
  /** 「停止」— cooperatively interrupts a running child. */
  onStop?: (childId: string) => void;
}) {
  const { payload, taskStatuses } = useMemo(
    () => childrenToCardModel(children),
    [children],
  );
  const delegateOnly = children.every((child) => Boolean(child.profile));

  if (!shouldShowOrchestrationBoard(children)) return null;
  return (
    <OrchestrationPlanCard
      payload={payload}
      taskStatuses={taskStatuses}
      headerLabel={delegateOnly ? t('Subagents') : undefined}
      hideMode={delegateOnly}
      renderTaskRow={(task, status) => {
        const child = children.find((item) => item.childId === task.id);
        // 没有匹配的智能体：编排六件套的子代理（只有 lineage id）或被删掉的
        // 智能体，显示画像原文。
        const agent = findAgentForProfile(task.agentId, agents);
        const displayName = agent?.name ?? task.agentId;
        const depth = child?.depth;
        const running = status === 'running';
        return (
          <li
            className="flex items-start gap-2 text-sm"
            data-testid={`orchestration-child-${task.id}`}
            // Grandchildren sit one step in, so the shape of the tree is
            // visible without expanding anything.
            style={depth && depth > 1 ? { paddingLeft: `${(depth - 1) * 14}px` } : undefined}
          >
            <span
              className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${ORCHESTRATION_DOT_CLASS[status]}`}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  data-agent-color-dot=""
                  className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold text-white"
                  style={{ backgroundColor: agent?.color || '#7c3aed' }}
                  aria-hidden
                >
                  {displayName.trim()[0]?.toUpperCase() ?? 'A'}
                </span>
                <span className="font-mono text-[11px] text-[var(--agent-muted-foreground,#6b7280)]">
                  {task.id}
                </span>
                <span className="font-medium text-[var(--agent-foreground,#111827)]">
                  {displayName}
                </span>
                {depth ? (
                  <span className="text-[10px] text-[var(--agent-muted-foreground,#6b7280)]">
                    {t('Depth {n}', { n: depth })}
                  </span>
                ) : null}
                <span className="text-xs text-[var(--agent-muted-foreground,#6b7280)]">
                  {childRowStatusLabel(child, status)}
                </span>
                {child?.elapsedMs !== undefined ? (
                  <span className="text-[10px] tabular-nums text-[var(--agent-muted-foreground,#6b7280)]">
                    {formatElapsed(child.elapsedMs)}
                  </span>
                ) : null}
                <span className="text-[10px] tabular-nums text-[var(--agent-muted-foreground,#6b7280)]">
                  {formatChildBill(child)}
                </span>
                <span className="ml-auto flex items-center gap-1.5">
                  {running && onStop ? (
                    <button
                      type="button"
                      onClick={() => onStop(task.id)}
                      className="rounded-full border border-agent-border px-1.5 py-0.5 text-[10px] text-agent-muted-foreground transition-colors hover:bg-agent-muted hover:text-agent-foreground"
                      data-testid={`orchestration-child-stop-${task.id}`}
                    >
                      {t('Stop')}
                    </button>
                  ) : null}
                  {!running && child && isChildResumable(child) && onContinue ? (
                    <button
                      type="button"
                      onClick={() => onContinue(task.id, child.recordId ?? '')}
                      className="rounded-full border border-agent-border px-1.5 py-0.5 text-[10px] text-agent-muted-foreground transition-colors hover:bg-agent-muted hover:text-agent-foreground"
                      data-testid={`orchestration-child-continue-${task.id}`}
                    >
                      {t('Continue')}
                    </button>
                  ) : null}
                  {child?.recordId && onViewProcess ? (
                    <button
                      type="button"
                      onClick={() => onViewProcess(child.recordId as string)}
                      className="rounded-full border border-agent-border px-1.5 py-0.5 text-[10px] text-agent-muted-foreground transition-colors hover:bg-agent-muted hover:text-agent-foreground"
                      aria-label={t('View process')}
                      title={t('View process')}
                      data-testid={`orchestration-child-process-${task.id}`}
                    >
                      …
                    </button>
                  ) : null}
                </span>
              </div>
              {child?.cacheNote === 'cold' ? (
                // R2 允许 fork 换模型，代价是父历史整体重算缓存。这是提示，
                // 不是错误——状态点不变色。
                <p
                  className="mt-0.5 text-[10px] text-[var(--agent-muted-foreground,#6b7280)]"
                  title={`${child.parentModel ?? ''} → ${child.childModel ?? ''}`}
                >
                  {t('Model switched · cache recomputed')}
                </p>
              ) : null}
              {task.prompt ? (
                <p className="mt-0.5 line-clamp-2 text-xs text-[var(--agent-muted-foreground,#6b7280)]">
                  {task.prompt}
                </p>
              ) : null}
            </div>
          </li>
        );
      }}
      defaultExpanded
    />
  );
}

/**
 * A row's status text.
 *
 * Two cases the card's own table cannot express: a child blocked on the user
 * is not "paused" (nothing will resume it but an answer), and one whose
 * question has been answered and handed to a new child is finished, not
 * waiting. Both are the whole point of the source annotation.
 */
function childRowStatusLabel(
  child: ChildInfo | undefined,
  status: OrchestrationTaskStatus,
): string {
  if (child?.needsInput) return t('Waiting for your answer');
  if (child?.handedOver) return t('Finished · handed over');
  return ORCHESTRATION_STATUS_LABEL[status];
}

/**
 * A child's token bill, or the fact that its engine does not report one.
 *
 * The distinction is the whole point: "0 tok" reads as a free run, while an
 * external ACP child really spent tokens nobody counted.
 */
function formatChildBill(child: ChildInfo | undefined): string {
  if (!child) return '';
  if (child.status === 'running') return '';
  if (!child.usage) return t('Not counted');
  return `${formatTokens(child.usage.totalTokens)} tok`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
}

export default OrchestrationChildrenCard;
