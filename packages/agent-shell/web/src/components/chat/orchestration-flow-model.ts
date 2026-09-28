/**
 * 多智能体协同编排模型（Orchestration Flow Model）
 *
 * 将 CoreLoop 编排六件套（agent_spawn / agent_wait / agent_send / agent_interrupt / agent_close / agent_list）
 * 以及 SSE agent.child 生命周期事件聚合成面向用户的 DAG 流程图与 Todo 式状态模型。
 */

import type { ChildInfo } from './orchestration-children-model';
import { parseToolEnvelope } from './executed-actions-model';
import { t } from '@/i18n';

export const ORCHESTRATION_TOOL_NAMES = [
  'agent_spawn',
  'agent_wait',
  'agent_send',
  'agent_interrupt',
  'agent_close',
  'agent_list',
] as const;

export type OrchestrationToolName = (typeof ORCHESTRATION_TOOL_NAMES)[number];

export function isOrchestrationTool(toolName: string): toolName is OrchestrationToolName {
  return (ORCHESTRATION_TOOL_NAMES as readonly string[]).includes(toolName);
}

export type OrchestrationNodeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'closed'
  | 'cancelled';

export interface OrchestrationSteer {
  message: string;
  delivery?: string;
}

export interface OrchestrationChildNode {
  childId: string;
  task: string;
  toolFilter?: string[];
  status: OrchestrationNodeStatus;
  answer?: string;
  steers: OrchestrationSteer[];
  interrupted?: boolean;
  closed?: boolean;
  recordId?: string;
  error?: string;
  spawnActionIndex?: number;
  waitActionIndex?: number;
}

export interface OrchestrationFlowData {
  nodes: OrchestrationChildNode[];
  totalCount: number;
  completedCount: number;
  runningCount: number;
  failedCount: number;
  interruptedCount: number;
  closedCount: number;
  isAllCompleted: boolean;
  hasActive: boolean;
  summaryCopy: string;
}

interface ActionLike {
  tool: string;
  arguments?: unknown;
  result?: unknown;
}

function toNodeStatus(raw: string | undefined): OrchestrationNodeStatus {
  switch (raw) {
    case 'pending':
    case 'running':
    case 'completed':
    case 'failed':
    case 'interrupted':
    case 'closed':
    case 'cancelled':
      return raw;
    case 'error':
      return 'failed';
    default:
      return 'running';
  }
}

function buildOrchestrationFlow(nodes: OrchestrationChildNode[]): OrchestrationFlowData | null {
  if (nodes.length === 0) return null;

  const totalCount = nodes.length;
  const completedCount = nodes.filter((n) => n.status === 'completed').length;
  const runningCount = nodes.filter((n) => n.status === 'running' || n.status === 'pending').length;
  const failedCount = nodes.filter((n) => n.status === 'failed').length;
  const interruptedCount = nodes.filter((n) => n.status === 'interrupted').length;
  const closedCount = nodes.filter((n) => n.status === 'closed' || n.status === 'cancelled').length;
  const isAllCompleted = totalCount > 0 && completedCount === totalCount;
  const hasActive = runningCount > 0;

  let summaryCopy = '';
  if (isAllCompleted) {
    summaryCopy = t('{completed}/{total} all done', {
      completed: completedCount,
      total: totalCount,
    });
  } else if (hasActive) {
    summaryCopy = t('Running together ({completed}/{total} done)...', {
      completed: completedCount,
      total: totalCount,
    });
  } else {
    summaryCopy = t('{completed} done · {ended} ended ({total} subtasks)', {
      completed: completedCount,
      ended: totalCount - completedCount,
      total: totalCount,
    });
  }

  return {
    nodes,
    totalCount,
    completedCount,
    runningCount,
    failedCount,
    interruptedCount,
    closedCount,
    isAllCompleted,
    hasActive,
    summaryCopy,
  };
}

/**
 * 父回合已经结束时，还标着 running/pending 的分支不会再收到子代理终态
 * （停止发生在流关闭之后）。把它们收成 cancelled，避免胶囊一直停在「协同执行中」。
 */
export function settleStoppedOrchestration(flow: OrchestrationFlowData): OrchestrationFlowData {
  if (!flow.nodes.some((node) => node.status === 'running' || node.status === 'pending')) {
    return flow;
  }
  return (
    buildOrchestrationFlow(
      flow.nodes.map((node) =>
        node.status === 'running' || node.status === 'pending'
          ? { ...node, status: 'cancelled' }
          : node,
      ),
    ) ?? flow
  );
}

function safeParseJson(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function extractOrchestrationFlow(
  actions?: readonly ActionLike[] | null,
  children?: readonly ChildInfo[] | null,
): OrchestrationFlowData | null {
  const nodeMap = new Map<string, OrchestrationChildNode>();

  // 1. 先用 SSE 累积的 ChildInfo 占位（实时性最高，包含 live 状态与 recordId）
  if (children && children.length > 0) {
    for (const c of children) {
      if (!c.childId) continue;
      nodeMap.set(c.childId, {
        childId: c.childId,
        task: c.task || '',
        status: toNodeStatus(c.status),
        recordId: c.recordId,
        steers: [],
      });
    }
  }

  // 2. 扫描 actions 里的编排六件套
  const actionList = actions ?? [];
  let hasOrchAction = false;

  actionList.forEach((action, actionIdx) => {
    if (!isOrchestrationTool(action.tool)) return;
    hasOrchAction = true;

    const rawArgs = safeParseJson(action.arguments) ?? {};
    const envelope = parseToolEnvelope(action.result);
    const innerMsg = safeParseJson(envelope.message);
    const innerData = safeParseJson(envelope.fields?.data);

    if (action.tool === 'agent_spawn') {
      const task = typeof rawArgs.task === 'string' ? rawArgs.task.trim() : '';
      const rawFilter = Array.isArray(rawArgs.toolFilter) ? rawArgs.toolFilter.map(String) : undefined;

      // childId 优先从结果里提取
      const childId =
        (typeof envelope.fields.childId === 'string' ? envelope.fields.childId : null) ??
        (typeof innerData?.childId === 'string' ? innerData.childId : null) ??
        (typeof innerMsg?.childId === 'string' ? innerMsg.childId : null) ??
        `spawn-${actionIdx}`;

      let node = nodeMap.get(childId);
      if (!node) {
        node = {
          childId,
          task,
          toolFilter: rawFilter,
          status: 'running',
          steers: [],
          spawnActionIndex: actionIdx,
        };
        nodeMap.set(childId, node);
      } else {
        if (!node.task && task) node.task = task;
        if (!node.toolFilter && rawFilter) node.toolFilter = rawFilter;
        if (node.spawnActionIndex === undefined) node.spawnActionIndex = actionIdx;
      }

      if (envelope.success === false || envelope.error) {
        node.status = 'failed';
        node.error = envelope.error || t('Dispatch failed');
      }
    } else if (action.tool === 'agent_wait') {
      const childId = typeof rawArgs.childId === 'string' ? rawArgs.childId.trim() : '';
      if (childId) {
        let node = nodeMap.get(childId);
        if (!node) {
          node = {
            childId,
            task: '',
            status: 'running',
            steers: [],
            waitActionIndex: actionIdx,
          };
          nodeMap.set(childId, node);
        } else {
          node.waitActionIndex = actionIdx;
        }

        const waitStatus =
          (typeof innerData?.status === 'string' ? innerData.status : null) ??
          (typeof innerMsg?.status === 'string' ? innerMsg.status : null);
        const answer =
          (typeof innerMsg?.answer === 'string' ? innerMsg.answer : null) ??
          (typeof innerData?.answer === 'string' ? innerData.answer : null);

        if (answer) {
          node.answer = answer;
        }

        if (waitStatus === 'completed') {
          node.status = 'completed';
        } else if (waitStatus === 'failed' || waitStatus === 'error' || envelope.success === false) {
          node.status = 'failed';
          node.error = envelope.error || t('Run failed');
        } else if (waitStatus === 'cancelled') {
          node.status = 'cancelled';
        } else if (waitStatus === 'interrupted') {
          node.interrupted = true;
          node.status = 'interrupted';
        } else if (waitStatus === 'closed') {
          node.closed = true;
          if (node.status !== 'completed') node.status = 'closed';
        } else if (waitStatus === 'running') {
          node.status = 'running';
        }
      }
    } else if (action.tool === 'agent_send') {
      const childId = typeof rawArgs.childId === 'string' ? rawArgs.childId.trim() : '';
      const message = typeof rawArgs.message === 'string' ? rawArgs.message.trim() : '';
      if (childId && message) {
        const node = nodeMap.get(childId);
        if (node) {
          const delivery =
            (typeof innerData?.delivery === 'string' ? innerData.delivery : null) ??
            (typeof innerMsg?.delivery === 'string' ? innerMsg.delivery : null);
          node.steers.push({ message, delivery: delivery ?? undefined });
        }
      }
    } else if (action.tool === 'agent_interrupt') {
      const childId = typeof rawArgs.childId === 'string' ? rawArgs.childId.trim() : '';
      if (childId) {
        const node = nodeMap.get(childId);
        if (node) {
          node.interrupted = true;
          node.status = 'interrupted';
        }
      }
    } else if (action.tool === 'agent_close') {
      const childId = typeof rawArgs.childId === 'string' ? rawArgs.childId.trim() : '';
      if (childId) {
        const node = nodeMap.get(childId);
        if (node) {
          node.closed = true;
          if (node.status !== 'completed') {
            node.status = 'closed';
          }
        }
      }
    } else if (action.tool === 'agent_list') {
      const childrenArr = Array.isArray(innerMsg?.children) ? innerMsg.children : null;
      if (childrenArr) {
        for (const rawChild of childrenArr) {
          if (rawChild && typeof rawChild === 'object') {
            const cid = typeof rawChild.childId === 'string' ? rawChild.childId : '';
            if (!cid) continue;
            const listedStatus =
              typeof rawChild.status === 'string' ? toNodeStatus(rawChild.status) : undefined;
            const listedAnswer =
              (typeof rawChild.answer === 'string' && rawChild.answer) ||
              (typeof rawChild.answerPreview === 'string' && rawChild.answerPreview) ||
              '';
            let node = nodeMap.get(cid);
            if (!node) {
              node = {
                childId: cid,
                task: typeof rawChild.task === 'string' ? rawChild.task : '',
                status: listedStatus ?? 'running',
                answer: listedAnswer || undefined,
                steers: [],
              };
              nodeMap.set(cid, node);
            } else {
              if (!node.task && rawChild.task) node.task = String(rawChild.task);
              if (!node.answer && listedAnswer) node.answer = listedAnswer;
              if (listedStatus) node.status = listedStatus;
            }
          }
        }
      }
    }
  });

  if (!hasOrchAction && (!children || children.length === 0)) {
    return null;
  }

  return buildOrchestrationFlow(Array.from(nodeMap.values()));
}

function actionsFromTimeline(blocks?: ReadonlyArray<{ type: string; actions?: unknown[] }>): ActionLike[] {
  if (!blocks) return [];
  const actions: ActionLike[] = [];
  for (const block of blocks) {
    if (block.type === 'tools' && Array.isArray(block.actions)) {
      actions.push(...(block.actions as ActionLike[]));
    }
  }
  return actions;
}

/**
 * 提取当前打开对话中最新一轮的编排流程。
 * 正在流式/执行中的回合优先；历史回合倒序寻找最新的一次编排。
 */
export function resolveLatestSessionOrchestrationFlow(input: {
  messages: Array<{ id: string }>;
  executedActionsByMessageId?: Record<string, ActionLike[]>;
  currentTurnActions?: ActionLike[];
  currentTurnChildren?: ChildInfo[];
  orchestrationChildrenByMessageId?: Record<string, ChildInfo[]>;
  timelineByMessageId?: Record<string, Array<{ type: string; actions?: unknown[] }>>;
  currentTurnTimeline?: Array<{ type: string; actions?: unknown[] }>;
  /** 父回合仍在流式输出。结束后残留的 running 分支收成已停止。 */
  turnActive?: boolean;
}): OrchestrationFlowData | null {
  const finish = (flow: OrchestrationFlowData | null, active: boolean) => {
    if (!flow || flow.totalCount === 0) return null;
    return active ? flow : settleStoppedOrchestration(flow);
  };

  // 1. 优先实时回合
  const liveActions =
    input.currentTurnActions ?? actionsFromTimeline(input.currentTurnTimeline);
  const liveFlow = finish(
    extractOrchestrationFlow(liveActions, input.currentTurnChildren),
    input.turnActive !== false,
  );
  if (liveFlow) return liveFlow;

  // 2. 倒序历史回合。落库的回合已经结束，残留 running 同样收成已停止。
  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    const id = input.messages[i].id;
    const actions =
      input.executedActionsByMessageId?.[id] ??
      actionsFromTimeline(input.timelineByMessageId?.[id]);
    const children = input.orchestrationChildrenByMessageId?.[id];
    const flow = finish(extractOrchestrationFlow(actions, children), false);
    if (flow) return flow;
  }

  return null;
}
