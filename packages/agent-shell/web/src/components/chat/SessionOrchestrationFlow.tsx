import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LuCircle,
  LuCircleCheck,
  LuCircleDot,
  LuCirclePause,
  LuCircleX,
  LuChevronDown,
  LuGitFork,
  LuLoaderCircle,
  LuBot,
  LuCheck,
  LuMessageSquare,
  LuExternalLink,
  LuX,
} from 'react-icons/lu';
import {
  type OrchestrationChildNode,
  type OrchestrationFlowData,
  type OrchestrationNodeStatus,
} from './orchestration-flow-model';
import type { InspectTaskInput } from './executed-actions-model';

function FlowNodeStatusIcon({
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
    case 'failed':
      return <LuCircleX className={`${cls} text-agent-destructive`} />;
    case 'pending':
    default:
      return <LuCircle className={`${cls} text-agent-muted-foreground/60`} />;
  }
}

export function currentActiveNode(nodes: OrchestrationChildNode[]): OrchestrationChildNode | null {
  return (
    nodes.find((n) => n.status === 'running' || n.status === 'pending') ??
    nodes[nodes.length - 1] ??
    null
  );
}

/**
 * 流程图分叉连线 (Fork Connector with directional arrows)
 *
 * 使用独立 SVG 容器与绝对定位，避免 viewBox 坐标在 stretch 时被水平拉伸成巨型扁箭头。
 */
function ForkConnector({ count }: { count: number }) {
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
        {/* 精确的连线条 */}
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
        {/* 左分支精致小箭头 */}
        <div className="absolute top-[17px] left-[25%] -translate-x-1/2">
          <svg className="h-2 w-2.5 text-violet-500/70" viewBox="0 0 10 8" fill="none">
            <polygon points="1,1 5,7 9,1" fill="currentColor" />
          </svg>
        </div>
        {/* 右分支精致小箭头 */}
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

  // 多分支（4+）
  return (
    <div className="flex h-5 w-full items-center justify-center">
      <svg className="h-5 w-4 text-violet-500/70" viewBox="0 0 16 20" fill="none">
        <line x1="8" y1="0" x2="8" y2="14" stroke="currentColor" strokeWidth="1.5" />
        <polygon points="5,13 8,19 11,13" fill="currentColor" />
      </svg>
    </div>
  );
}

/**
 * 流程图汇聚连线 (Join Connector with directional arrow)
 */
function JoinConnector({ count }: { count: number }) {
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

export function SessionOrchestrationFlow({
  flow,
  chatId,
  onInspectTask,
}: {
  flow: OrchestrationFlowData;
  chatId?: string | null;
  onInspectTask?: (task: InspectTaskInput) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { nodes, isAllCompleted, hasActive, summaryCopy } = flow;
  const activeNode = useMemo(() => currentActiveNode(nodes), [nodes]);

  // 执行中默认展开，全部完成默认收起为胶囊；支持用户手动点击切换展开状态
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const expanded = userToggled ?? hasActive;

  // 任务全部执行完成时自动收拢为胶囊
  useEffect(() => {
    if (isAllCompleted) {
      setUserToggled(false);
    }
  }, [isAllCompleted]);

  // 新出现执行中的任务时，恢复默认展开
  useEffect(() => {
    if (hasActive) {
      setUserToggled(null);
    }
  }, [hasActive]);

  // 全部完成后，如果用户手动展开了浮层，点击外部区域时自动收起
  useEffect(() => {
    if (!expanded || !isAllCompleted) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setUserToggled(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [expanded, isAllCompleted]);

  const gridColsClass =
    nodes.length === 2
      ? 'grid-cols-2'
      : nodes.length === 3
        ? 'grid-cols-3'
        : 'grid-cols-1 sm:grid-cols-2';

  return (
    <div
      ref={containerRef}
      className="relative inline-flex items-center"
      data-testid="session-orchestration-flow"
    >
      {/* 输入框上方的胶囊触发器按钮 (类似 SessionTodoList) */}
      <button
        type="button"
        onClick={() => setUserToggled(!expanded)}
        className={[
          'flex h-6 max-w-[260px] sm:max-w-[340px] items-center gap-1.5 rounded-full px-2 text-left text-[11px] transition-all duration-200 select-none shadow-2xs',
          isAllCompleted
            ? 'border border-emerald-500/25 bg-emerald-500/[0.04] text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/[0.08]'
            : hasActive
              ? 'border border-violet-500/30 bg-violet-500/[0.06] text-violet-700 dark:text-violet-300 hover:bg-violet-500/10'
              : 'border border-agent-border/80 bg-agent-canvas text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground',
        ].join(' ')}
        aria-expanded={expanded}
      >
        <div className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          {isAllCompleted ? (
            <LuCircleCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          ) : hasActive ? (
            <LuLoaderCircle className="h-3.5 w-3.5 animate-spin text-violet-600 dark:text-violet-400" />
          ) : (
            <LuGitFork className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
          )}
        </div>

        <span className="min-w-0 flex-1 truncate font-medium">
          {isAllCompleted
            ? '协同编排已就绪'
            : (activeNode?.task ? activeNode.task : '协同编排流程')}
        </span>

        {summaryCopy ? (
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.2 text-[10px] font-medium ${
              isAllCompleted
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : hasActive
                  ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
                  : 'bg-agent-muted text-agent-muted-foreground'
            }`}
          >
            {summaryCopy}
          </span>
        ) : null}

        <LuChevronDown
          className={`h-3 w-3 shrink-0 text-current transition-transform duration-200 ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/* 展开浮层：呈现真正的多智能体 Fork-Join 流程图 (DAG Flowchart) */}
      {expanded && (
        <div
          className="absolute bottom-full right-0 mb-1.5 w-[390px] sm:w-[480px] overflow-hidden rounded-agent-lg border border-agent-border bg-agent-canvas/98 backdrop-blur-md shadow-xl z-40 animate-in fade-in slide-in-from-bottom-1 duration-150"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-agent-border/60 bg-agent-muted/30 px-3 py-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
              <LuGitFork className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
              <span>多智能体协同流程</span>
              <span className="rounded-full bg-violet-500/10 px-1.5 py-0.2 text-[10px] font-medium text-violet-700 dark:text-violet-300">
                Fork-Join
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span
                className={`rounded-full px-1.5 py-0.2 text-[10px] font-medium ${
                  isAllCompleted
                    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : 'bg-violet-500/10 text-violet-600 dark:text-violet-400'
                }`}
              >
                {summaryCopy}
              </span>
              <button
                type="button"
                onClick={() => setUserToggled(false)}
                className="rounded p-0.5 text-agent-muted-foreground hover:bg-agent-foreground/10 hover:text-agent-foreground"
                aria-label="收起编排流程"
              >
                <LuX className="h-3 w-3" />
              </button>
            </div>
          </div>

          {/* 流程图图形主体 (DAG Flowchart) */}
          <div className="max-h-88 overflow-y-auto p-3">
            <div className="flex flex-col items-center">
              {/* 1. 起点：目标分发 (Fork) 居中节点 */}
              <div className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/10 px-3.5 py-1 text-xs font-semibold text-violet-800 dark:text-violet-200 shadow-2xs">
                <LuBot className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
                <span>目标分发 (Fork)</span>
                <span className="rounded-full bg-violet-500/20 px-1.5 py-0.2 text-[10px] font-medium text-violet-700 dark:text-violet-300">
                  并发 {nodes.length} 分支
                </span>
              </div>

              {/* 2. 向下的分叉流线 (带箭头指向每个并行分支) */}
              <ForkConnector count={nodes.length} />

              {/* 3. 并行子任务节点网格 (类似 Todo 的紧凑卡片) */}
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
                        {/* 节点顶栏：Todo 式勾选/圆点 + 分支编号 + 状态 */}
                        <div className="flex items-center justify-between gap-1 border-b border-agent-border/40 pb-1.5">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <FlowNodeStatusIcon status={node.status} />
                            <span className="font-semibold text-agent-foreground text-[11px] truncate">
                              分支 #{index + 1}
                            </span>
                          </div>

                          <div className="flex items-center gap-1">
                            <span
                              className={`rounded-full border px-1.5 py-0.2 text-[10px] font-medium ${
                                done
                                  ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                  : active
                                    ? 'border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300'
                                    : 'border-agent-border bg-agent-muted text-agent-muted-foreground'
                              }`}
                            >
                              {done ? '已完成' : active ? '执行中' : '等待中'}
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
                                title="查看过程"
                              >
                                <LuExternalLink className="h-2.5 w-2.5" />
                                <span>过程</span>
                              </button>
                            ) : null}
                          </div>
                        </div>

                        {/* 任务内容 (Todo 项文本) */}
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

                        {/* 追加指令 (Steer) */}
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

                      {/* 底部产出结果 (Answer 绿色结果徽章) */}
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

              {/* 4. 向下的汇聚流线 (两路分支引出，汇入 Join 节点) */}
              <JoinConnector count={nodes.length} />

              {/* 5. 终点：结果汇聚 (Join) 居中节点 */}
              <div
                className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1 text-xs font-semibold shadow-2xs ${
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
        </div>
      )}
    </div>
  );
}

export default SessionOrchestrationFlow;
