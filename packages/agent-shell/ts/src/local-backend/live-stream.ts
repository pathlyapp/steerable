/**
 * 运行中回合的「实时快照」注册表 —— 让 renderer 在切走再切回时能把正在
 * 流式的回合重新接上（显示运行状态 + 已产出的部分内容 / 工具卡片 / 时间线）。
 *
 * 背景：AgentChatView 卸载时不再取消回合（回合不因切页而暂停），但该回合
 * 的 SSE 事件只会流向当初发起 fetch 的那个组件；切回后的新组件拿不到这些
 * 事件，只能靠轮询本注册表把「运行中 + 部分产出」恢复出来。
 *
 * 设计：注册表只存「正在运行」的回合。router 的 handleCoreLoopTurn 在
 * 流开始前 register、每个产出点更新 content、结束（落库后）立即 remove。
 * executedActions / timeline / children 三个字段存的是 router 里同名的
 * 活数组引用（appendTimelineDelta / syncTimelineTools / onToolAction 都
 * 原地 mutate），因此 GET 序列化时自然读到最新状态，无需逐事件拷贝。
 */
import { syncTimelineTools, type PersistedTurnBlock } from './turn-timeline.js';

export interface LiveStreamState {
  chatId: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  /** 已产出的助手文本（部分）。 */
  content: string;
  /** 已产出的工具调用卡片（原地 mutate 的活数组）。 */
  executedActions: Array<Record<string, unknown>>;
  /** 调用顺序时间线（原地 mutate 的活数组）。 */
  timeline: PersistedTurnBlock[];
  /** 编排子代理生命周期事件（按到达顺序累积）。 */
  children: Array<Record<string, unknown>>;
  /** 出网放行写入 executedActions 后通知正在看这一轮的界面。 */
  notify?: () => void;
}

const liveStreams = new Map<string, LiveStreamState>();

/** 把一次已允许的出网放行记进正在运行的回合。这不是工具结果，模型看不到。 */
export function recordGrantedEgress(
  live: LiveStreamState,
  grant: {
    requestId: string;
    arguments: Record<string, unknown>;
    kind: string;
    reason: string;
  },
): void {
  live.executedActions.push({
    id: `egress-${grant.requestId}`,
    tool: 'network_egress',
    arguments: grant.arguments,
    success: true,
    approval: {
      kind: grant.kind,
      ...(grant.reason === 'unattended' ? { auto: true } : {}),
    },
  });
  syncTimelineTools(live.timeline, live.executedActions);
  live.notify?.();
}

export function registerLiveStream(
  chatId: string,
  refs: {
    executedActions: Array<Record<string, unknown>>;
    timeline: PersistedTurnBlock[];
    children: Array<Record<string, unknown>>;
  },
): LiveStreamState {
  const state: LiveStreamState = {
    chatId,
    status: 'running',
    content: '',
    executedActions: refs.executedActions,
    timeline: refs.timeline,
    children: refs.children,
  };
  liveStreams.set(chatId, state);
  return state;
}

export function getLiveStream(chatId: string): LiveStreamState | undefined {
  return liveStreams.get(chatId);
}

export function removeLiveStream(chatId: string): void {
  liveStreams.delete(chatId);
}

/** 供测试 / 诊断使用。 */
export function liveStreamCount(): number {
  return liveStreams.size;
}
