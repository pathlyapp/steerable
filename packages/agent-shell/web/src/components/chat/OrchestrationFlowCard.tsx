import { useEffect, useState } from 'react';
import {
  LuCircle,
  LuCircleCheck,
  LuCircleDot,
  LuCirclePause,
  LuCircleX,
  LuChevronDown,
  LuChevronRight,
  LuGitFork,
  LuLoaderCircle,
  LuBot,
  LuCheck,
  LuMessageSquare,
  LuExternalLink,
} from 'react-icons/lu';
import {
  type OrchestrationFlowData,
  type OrchestrationNodeStatus,
} from './orchestration-flow-model';
import type { InspectTaskInput } from './executed-actions-model';
import { t } from '@/i18n';

function NodeStatusIcon({
  status,
  className = '',
}: {
  status: OrchestrationNodeStatus;
  className?: string;
}) {
  const cls = `h-3.5 w-3.5 shrink-0 ${className}`.trim();
  switch (status) {
    case 'completed':
      return <LuCircleCheck className={`${cls} text-emerald-600 dark:text-emerald-400`} />;
    case 'running':
      return <LuCircleDot className={`${cls} animate-pulse text-blue-600 dark:text-blue-400`} />;
    case 'interrupted':
      return <LuCirclePause className={`${cls} text-amber-600 dark:text-amber-400`} />;
    case 'cancelled':
      return <LuCircleX className={`${cls} text-agent-foreground`} />;
    case 'closed':
      return <LuCircleX className={`${cls} text-agent-muted-foreground`} />;
    case 'failed':
      return <LuCircleX className={`${cls} text-agent-destructive`} />;
    case 'pending':
    default:
      return <LuCircle className={`${cls} text-agent-muted-foreground/60`} />;
  }
}

function statusBadgeText(status: OrchestrationNodeStatus): string {
  switch (status) {
    case 'completed':
      return t('Completed');
    case 'running':
      return t('Running');
    case 'interrupted':
      return t('Paused');
    case 'cancelled':
      return t('Stopped');
    case 'closed':
      return t('Closed');
    case 'failed':
      return t('Failed');
    case 'pending':
    default:
      return t('Waiting');
  }
}

function statusBadgeStyle(status: OrchestrationNodeStatus): string {
  switch (status) {
    case 'completed':
      return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20';
    case 'running':
      return 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/20';
    case 'interrupted':
      return 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20';
    case 'cancelled':
      return 'bg-agent-muted text-agent-foreground border-agent-border';
    case 'closed':
      return 'bg-agent-muted text-agent-muted-foreground border-agent-border';
    case 'failed':
      return 'bg-agent-destructive/10 text-agent-destructive border-agent-destructive/20';
    case 'pending':
    default:
      return 'bg-agent-muted text-agent-muted-foreground border-agent-border';
  }
}

function ForkLines({ count }: { count: number }) {
  if (count <= 1) {
    return (
      <div className="flex h-5 w-full items-center justify-center">
        <svg className="h-5 w-4 text-violet-500/70" viewBox="0 0 16 20" fill="none">
          <line x1="8" y1="0" x2="8" y2="14" stroke="currentColor" strokeWidth="1.5" />
          <polygon points="5,13 8,19 11,13" fill="currentColor" />
        </svg>
      </div>
    );
  }

  if (count === 2) {
    return (
      <div className="relative h-6 w-full">
        <svg
          className="absolute inset-0 h-full w-full text-violet-500/70"
          viewBox="0 0 100 24"
          preserveAspectRatio="none"
          fill="none"
        >
          <path
            d="M 50 0 L 50 12 M 25 12 L 75 12 M 25 12 L 25 18 M 75 12 L 75 18"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="absolute top-[17px] left-[25%] -translate-x-1/2">
          <svg className="h-2 w-2.5 text-violet-500/70" viewBox="0 0 10 8" fill="none">
            <polygon points="1,1 5,7 9,1" fill="currentColor" />
          </svg>
        </div>
        <div className="absolute top-[17px] left-[75%] -translate-x-1/2">
          <svg className="h-2 w-2.5 text-violet-500/70" viewBox="0 0 10 8" fill="none">
            <polygon points="1,1 5,7 9,1" fill="currentColor" />
          </svg>
        </div>
      </div>
    );
  }

  if (count === 3) {
    return (
      <div className="relative h-6 w-full">
        <svg
          className="absolute inset-0 h-full w-full text-violet-500/70"
          viewBox="0 0 100 24"
          preserveAspectRatio="none"
          fill="none"
        >
          <path
            d="M 50 0 L 50 18 M 17 12 L 83 12 M 17 12 L 17 18 M 83 12 L 83 18"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="absolute top-[17px] left-[17%] -translate-x-1/2">
          <svg className="h-2 w-2.5 text-violet-500/70" viewBox="0 0 10 8" fill="none">
            <polygon points="1,1 5,7 9,1" fill="currentColor" />
          </svg>
        </div>
        <div className="absolute top-[17px] left-[50%] -translate-x-1/2">
          <svg className="h-2 w-2.5 text-violet-500/70" viewBox="0 0 10 8" fill="none">
            <polygon points="1,1 5,7 9,1" fill="currentColor" />
          </svg>
        </div>
        <div className="absolute top-[17px] left-[83%] -translate-x-1/2">
          <svg className="h-2 w-2.5 text-violet-500/70" viewBox="0 0 10 8" fill="none">
            <polygon points="1,1 5,7 9,1" fill="currentColor" />
          </svg>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-5 w-full items-center justify-center">
      <svg className="h-5 w-4 text-violet-500/70" viewBox="0 0 16 20" fill="none">
        <line x1="8" y1="0" x2="8" y2="14" stroke="currentColor" strokeWidth="1.5" />
        <polygon points="5,13 8,19 11,13" fill="currentColor" />
      </svg>
    </div>
  );
}

function JoinLines({ count }: { count: number }) {
  if (count <= 1) {
    return (
      <div className="flex h-5 w-full items-center justify-center">
        <svg className="h-5 w-4 text-violet-500/70" viewBox="0 0 16 20" fill="none">
          <line x1="8" y1="0" x2="8" y2="14" stroke="currentColor" strokeWidth="1.5" />
          <polygon points="5,13 8,19 11,13" fill="currentColor" />
        </svg>
      </div>
    );
  }

  if (count === 2) {
    return (
      <div className="relative h-6 w-full">
        <svg
          className="absolute inset-0 h-full w-full text-violet-500/70"
          viewBox="0 0 100 24"
          preserveAspectRatio="none"
          fill="none"
        >
          <path
            d="M 25 0 L 25 12 M 75 0 L 75 12 M 25 12 L 75 12 M 50 12 L 50 18"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="absolute top-[17px] left-[50%] -translate-x-1/2">
          <svg className="h-2 w-2.5 text-violet-500/70" viewBox="0 0 10 8" fill="none">
            <polygon points="1,1 5,7 9,1" fill="currentColor" />
          </svg>
        </div>
      </div>
    );
  }

  if (count === 3) {
    return (
      <div className="relative h-6 w-full">
        <svg
          className="absolute inset-0 h-full w-full text-violet-500/70"
          viewBox="0 0 100 24"
          preserveAspectRatio="none"
          fill="none"
        >
          <path
            d="M 17 0 L 17 12 M 50 0 L 50 18 M 83 0 L 83 12 M 17 12 L 83 12 M 50 12 L 50 18"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="absolute top-[17px] left-[50%] -translate-x-1/2">
          <svg className="h-2 w-2.5 text-violet-500/70" viewBox="0 0 10 8" fill="none">
            <polygon points="1,1 5,7 9,1" fill="currentColor" />
          </svg>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-5 w-full items-center justify-center">
      <svg className="h-5 w-4 text-violet-500/70" viewBox="0 0 16 20" fill="none">
        <line x1="8" y1="0" x2="8" y2="14" stroke="currentColor" strokeWidth="1.5" />
        <polygon points="5,13 8,19 11,13" fill="currentColor" />
      </svg>
    </div>
  );
}

export function OrchestrationFlowCard({
  flow,
  chatId,
  onInspectTask,
  className = '',
  defaultExpanded = false,
}: {
  flow: OrchestrationFlowData;
  chatId?: string | null;
  onInspectTask?: (task: InspectTaskInput) => void;
  className?: string;
  defaultExpanded?: boolean;
}) {
  const { nodes, isAllCompleted, hasActive, summaryCopy } = flow;

  const [userToggled, setUserToggled] = useState<boolean | null>(defaultExpanded ? true : null);
  const expanded = userToggled ?? defaultExpanded;

  useEffect(() => {
    if (isAllCompleted && defaultExpanded) {
      setUserToggled(false);
    }
  }, [isAllCompleted, defaultExpanded]);

  const gridColsClass =
    nodes.length === 2
      ? 'grid-cols-2'
      : nodes.length === 3
        ? 'grid-cols-3'
        : 'grid-cols-1 sm:grid-cols-2';

  return (
    <div
      className={`my-2 overflow-hidden rounded-agent-lg border border-agent-border bg-agent-canvas shadow-xs ${className}`}
      data-testid="orchestration-flow-card"
    >
      {/* 顶部 Todo 风格状态胶囊 Header */}
      <button
        type="button"
        onClick={() => setUserToggled((prev) => (prev === null ? !expanded : !prev))}
        className="flex w-full items-center justify-between border-b border-agent-border bg-agent-muted/30 px-3 py-2 text-left transition-colors hover:bg-agent-muted/50"
        aria-expanded={expanded}
      >
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400">
            <LuGitFork className="h-3 w-3" />
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-agent-foreground">
            <span>{t('Multi-agent orchestration')}</span>
            <span className="rounded-full bg-violet-500/10 px-1.5 py-0.2 text-[10px] font-medium text-violet-700 dark:text-violet-300">
              {t('Fork-Join flow')}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
              isAllCompleted
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : hasActive
                  ? 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300'
                  : 'border-agent-border bg-agent-muted text-agent-muted-foreground'
            }`}
          >
            {isAllCompleted ? (
              <LuCircleCheck className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
            ) : hasActive ? (
              <LuLoaderCircle className="h-3 w-3 animate-spin text-blue-600 dark:text-blue-400" />
            ) : (
              <LuCheck className="h-3 w-3" />
            )}
            <span>{summaryCopy}</span>
          </span>
          {expanded ? (
            <LuChevronDown className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
          ) : (
            <LuChevronRight className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
          )}
        </div>
      </button>

      {/* 展开后的流程图 (真正的 Fork-Join DAG 图形) */}
      {expanded ? (
        <div className="p-3">
          <div className="flex flex-col items-center">
            {/* 1. 起点：目标分发 (Fork) 居中胶囊节点 */}
            <div className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-xs font-semibold text-violet-800 dark:text-violet-200 shadow-2xs">
              <LuBot className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
              <span>{t('Main agent goal dispatch (Fork)')}</span>
              <span className="rounded-full bg-violet-500/20 px-1.5 py-0.2 text-[10px] font-medium text-violet-700 dark:text-violet-300">
                {t('{count} parallel branches', { count: nodes.length })}
              </span>
            </div>

            {/* 2. 向下的分流连线 */}
            <ForkLines count={nodes.length} />

            {/* 3. 并行分支节点网格 */}
            <div className={`grid w-full gap-2.5 ${gridColsClass}`}>
              {nodes.map((node, index) => {
                const done = node.status === 'completed';
                const active = node.status === 'running' || node.status === 'pending';
                const canInspect = Boolean(chatId && onInspectTask && node.recordId);

                return (
                  <div
                    key={node.childId || `node-${index}`}
                    className="flex flex-col justify-between rounded-agent-md border border-agent-border/80 bg-agent-muted/20 p-2.5 text-xs shadow-2xs transition-all hover:border-agent-border hover:bg-agent-muted/30"
                  >
                    <div>
                      {/* 节点顶栏：状态与编号 */}
                      <div className="flex items-center justify-between gap-1 border-b border-agent-border/40 pb-1.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <NodeStatusIcon status={node.status} />
                          <span className="font-semibold text-agent-foreground text-[11px] truncate">
                            {t('Branch #{index}', { index: index + 1 })}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span
                            className={`rounded-full border px-1.5 py-0.2 text-[10px] font-medium ${statusBadgeStyle(
                              node.status,
                            )}`}
                          >
                            {statusBadgeText(node.status)}
                          </span>
                          {canInspect && chatId ? (
                            <button
                              type="button"
                              onClick={() =>
                                onInspectTask?.({
                                  id: node.childId,
                                  chatId,
                                  recordId: node.recordId,
                                  live: node.status === 'running',
                                  title: node.task || t('Subagent run'),
                                })
                              }
                              className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[10px] text-agent-muted-foreground hover:bg-agent-muted hover:text-agent-foreground"
                              title={t('View reasoning process')}
                            >
                              <LuExternalLink className="h-2.5 w-2.5" />
                              <span>{t('Process')}</span>
                            </button>
                          ) : null}
                        </div>
                      </div>

                      {/* 任务描述 */}
                      <div className="mt-1.5 leading-relaxed">
                        <p
                          className={`line-clamp-3 text-[11px] ${
                            done
                              ? 'text-agent-foreground/90 font-medium'
                              : active
                                ? 'text-agent-foreground font-semibold'
                                : 'text-agent-muted-foreground'
                          }`}
                          title={node.task}
                        >
                          {node.task || t('Subtask ({id})', { id: node.childId })}
                        </p>
                      </div>

                      {/* 追加指令 */}
                      {node.steers.length > 0 ? (
                        <div className="mt-1.5 space-y-0.5 rounded border border-amber-800/20 bg-amber-100 px-1.5 py-1 text-[10px] text-amber-950">
                          {node.steers.map((s, sIdx) => (
                            <div key={sIdx} className="flex items-start gap-1">
                              <LuMessageSquare className="mt-0.5 h-2.5 w-2.5 shrink-0 text-amber-900" />
                              <span className="truncate">{s.message}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    {/* 结论预览 */}
                    {node.answer ? (
                      <div className="mt-2 rounded bg-emerald-500/10 border border-emerald-500/20 px-2 py-1 text-[11px]">
                        <div className="flex items-center gap-1 font-semibold text-emerald-800 dark:text-emerald-200 text-[10px]">
                          <LuCheck className="h-3 w-3" />
                          <span>{t('Conclusion:')}</span>
                          <span className="font-mono text-emerald-950 dark:text-emerald-50 truncate">
                            {node.answer}
                          </span>
                        </div>
                      </div>
                    ) : node.error ? (
                      <div className="mt-2 rounded bg-agent-destructive/10 px-1.5 py-1 text-[10px] text-agent-destructive truncate">
                        {t('Failed: {error}', { error: node.error })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {/* 4. 向下的汇聚连线 */}
            <JoinLines count={nodes.length} />

            {/* 5. 终点：结果汇聚 (Join) 居中胶囊节点 */}
            <div
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold shadow-2xs ${
                isAllCompleted
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
                  : 'border-agent-border bg-agent-muted text-agent-muted-foreground'
              }`}
            >
              <LuCircleCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              <span>{t('Result merge (Join)')}</span>
              <span className="text-[10px] opacity-80">
                {isAllCompleted
                  ? t('All branches merged and answered')
                  : hasActive
                    ? t('Waiting for branches...')
                    : t('Stopped')}
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default OrchestrationFlowCard;
