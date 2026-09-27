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
      return '已完成';
    case 'running':
      return '执行中';
    case 'interrupted':
      return '已暂停';
    case 'closed':
      return '已关闭';
    case 'failed':
      return '失败';
    case 'pending':
    default:
      return '等待中';
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
  if (count === 1) {
    return (
      <div className="flex h-5 w-full justify-center">
        <svg className="h-5 w-6 text-violet-500/50" viewBox="0 0 24 20" fill="none">
          <line x1="12" y1="0" x2="12" y2="16" stroke="currentColor" strokeWidth="1.5" />
          <polygon points="9,14 12,19 15,14" fill="currentColor" />
        </svg>
      </div>
    );
  }

  if (count === 2) {
    return (
      <div className="h-6 w-full px-2">
        <svg className="h-6 w-full text-violet-500/50" viewBox="0 0 100 24" preserveAspectRatio="none" fill="none">
          <path
            d="M 50 0 L 50 10 M 25 10 L 75 10 M 25 10 L 25 20 M 75 10 L 75 20"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <polygon points="23,17 25,22 27,17" fill="currentColor" />
          <polygon points="73,17 75,22 77,17" fill="currentColor" />
        </svg>
      </div>
    );
  }

  if (count === 3) {
    return (
      <div className="h-6 w-full px-2">
        <svg className="h-6 w-full text-violet-500/50" viewBox="0 0 100 24" preserveAspectRatio="none" fill="none">
          <path
            d="M 50 0 L 50 20 M 17 10 L 83 10 M 17 10 L 17 20 M 83 10 L 83 20"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <polygon points="15,17 17,22 19,17" fill="currentColor" />
          <polygon points="48,17 50,22 52,17" fill="currentColor" />
          <polygon points="81,17 83,22 85,17" fill="currentColor" />
        </svg>
      </div>
    );
  }

  return (
    <div className="flex h-5 w-full justify-center">
      <svg className="h-5 w-6 text-violet-500/50" viewBox="0 0 24 20" fill="none">
        <line x1="12" y1="0" x2="12" y2="16" stroke="currentColor" strokeWidth="1.5" />
        <polygon points="9,14 12,19 15,14" fill="currentColor" />
      </svg>
    </div>
  );
}

function JoinLines({ count }: { count: number }) {
  if (count === 1) {
    return (
      <div className="flex h-5 w-full justify-center">
        <svg className="h-5 w-6 text-violet-500/50" viewBox="0 0 24 20" fill="none">
          <line x1="12" y1="0" x2="12" y2="16" stroke="currentColor" strokeWidth="1.5" />
          <polygon points="9,14 12,19 15,14" fill="currentColor" />
        </svg>
      </div>
    );
  }

  if (count === 2) {
    return (
      <div className="h-6 w-full px-2">
        <svg className="h-6 w-full text-violet-500/50" viewBox="0 0 100 24" preserveAspectRatio="none" fill="none">
          <path
            d="M 25 0 L 25 10 M 75 0 L 75 10 M 25 10 L 75 10 M 50 10 L 50 20"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <polygon points="48,17 50,22 52,17" fill="currentColor" />
        </svg>
      </div>
    );
  }

  if (count === 3) {
    return (
      <div className="h-6 w-full px-2">
        <svg className="h-6 w-full text-violet-500/50" viewBox="0 0 100 24" preserveAspectRatio="none" fill="none">
          <path
            d="M 17 0 L 17 10 M 50 0 L 50 20 M 83 0 L 83 10 M 17 10 L 83 10"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <polygon points="48,17 50,22 52,17" fill="currentColor" />
        </svg>
      </div>
    );
  }

  return (
    <div className="flex h-5 w-full justify-center">
      <svg className="h-5 w-6 text-violet-500/50" viewBox="0 0 24 20" fill="none">
        <line x1="12" y1="0" x2="12" y2="16" stroke="currentColor" strokeWidth="1.5" />
        <polygon points="9,14 12,19 15,14" fill="currentColor" />
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
            <span>多智能体协同编排</span>
            <span className="rounded-full bg-violet-500/10 px-1.5 py-0.2 text-[10px] font-medium text-violet-700 dark:text-violet-300">
              Fork-Join 流程
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
              <span>主智能体目标分发 (Fork)</span>
              <span className="rounded-full bg-violet-500/20 px-1.5 py-0.2 text-[10px] font-medium text-violet-700 dark:text-violet-300">
                并发 {nodes.length} 分支
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
                            分支 #{index + 1}
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
                                  title: node.task || '子代理执行过程',
                                })
                              }
                              className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[10px] text-agent-muted-foreground hover:bg-agent-muted hover:text-agent-foreground"
                              title="查看推理过程"
                            >
                              <LuExternalLink className="h-2.5 w-2.5" />
                              <span>过程</span>
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
                          {node.task || `子任务 (${node.childId})`}
                        </p>
                      </div>

                      {/* 追加指令 */}
                      {node.steers.length > 0 ? (
                        <div className="mt-1.5 space-y-0.5 rounded bg-amber-500/5 p-1 text-[10px] text-amber-800 dark:text-amber-200">
                          {node.steers.map((s, sIdx) => (
                            <div key={sIdx} className="flex items-start gap-1">
                              <LuMessageSquare className="mt-0.5 h-2.5 w-2.5 shrink-0 text-amber-600" />
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
                          <span>结论:</span>
                          <span className="font-mono text-emerald-950 dark:text-emerald-50 truncate">
                            {node.answer}
                          </span>
                        </div>
                      </div>
                    ) : node.error ? (
                      <div className="mt-2 rounded bg-agent-destructive/10 px-1.5 py-1 text-[10px] text-agent-destructive truncate">
                        失败: {node.error}
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
              <span>结果汇聚 (Join)</span>
              <span className="text-[10px] opacity-80">
                {isAllCompleted ? '所有分支已汇聚并完成回答' : '等待分支就绪...'}
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default OrchestrationFlowCard;
