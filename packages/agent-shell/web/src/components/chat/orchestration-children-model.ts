import type { OrchestrationTaskStatus } from '@steerable/agent-ui/cards';
import type { OrchestrationPlanPayload } from '@steerable/agent-protocol';

/**
 * Pure model half of OrchestrationChildrenCard — no React and no runtime
 * framework imports (type-only, erased at build), so the desktop's node
 * vitest suite can exercise the mapping without the agent-ui dist build.
 *
 * The sidecar emits `agent.child` lifecycle notifications for orchestration
 * children AND for `delegate_subagent` delegations (delegate-on-pool); the
 * router forwards them as `orchestration_child` SSE events and AgentPage
 * accumulates them into the `ChildInfo` list below.
 */

export interface ChildInfo {
  childId: string;
  /** Spawn task text (only `child_spawned` carries it). */
  task?: string;
  depth?: number;
  /** Resolved subagent profile (delegate children; `general-purpose` when
   * the delegation named no subagent_type). Rendered as the task's agent. */
  profile?: string;
  /** running | completed | failed | cancelled | interrupted */
  status: string;
  /** 子代理自己的 durable record；右侧过程面板据此回看它的推理与工具。 */
  recordId?: string;
  /**
   * R5: this child's bill. Absent while running, and absent for a child on
   * an engine that reports no tokens at all (external ACP) — the two mean
   * different things, so the row shows "not counted" for the settled one
   * instead of `0 tok`.
   */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Wall-clock the child ran, from spawn to terminal event. */
  elapsedMs?: number;
  /** R2: the fork re-read the parent history on a different model route. */
  cacheNote?: 'cold';
  parentModel?: string;
  childModel?: string;
  /**
   * R7-3: this child stopped to ask the user something.
   *
   * Set by `child_needs_input`; cleared when the parent hands over the answer
   * (the delegation result that follows), so the row stops saying 「等待你的
   * 回答」 once the user has answered.
   */
  needsInput?: { intro: string };
  /**
   * R7-3: this child asked for input and the parent has since passed the
   * answer on. It is not running any more, so the row reads 「已结束 · 已转交」.
   */
  handedOver?: boolean;
}

/**
 * 把一次 `delegate_subagent` 调用对上它的子代理。
 *
 * 工具行只有画像名与任务正文，子代理的 record 在生命周期事件里；`task` 就是
 * 这次调用的 `task` 参数，所以两者精确相等。同一画像被派了多份活时按顺序
 * 消费，`taken` 记下已配对的 childId。
 *
 * @param call 这次委派的画像名与任务正文。
 * @param children 本回合累积的子代理列表。
 * @param taken 已被前面的行配对掉的 childId。
 * @returns 命中的子代理，或 undefined（历史回合没有事件、六件套子代理等）。
 */
export function matchChildForDelegation(
  call: { profile: string | null; task: string | null },
  children: ReadonlyArray<ChildInfo>,
  taken: ReadonlySet<string> = new Set(),
): ChildInfo | undefined {
  return children.find((child) => {
    if (taken.has(child.childId)) return false;
    if (call.task && child.task && child.task.trim() !== call.task.trim()) return false;
    if (!call.task && child.task) return false;
    if (call.profile && child.profile && child.profile !== call.profile) return false;
    return true;
  });
}

/**
 * 画像名的派生规则，与宿主 `local-backend/subagent-profiles.ts` 的
 * `profileNameForAgent` 一致（两包不能互相 import：那边带 fs / sqlite）。
 *
 * 没有 slug 的自建智能体（中文名 slugify 后为空）会拿到
 * `agent-<id 前 16 位字母数字>` 这种派生名——只按 slug/id 反查就映射不回来，
 * 行头只能显示这串 id。所以这里把宿主的整条链都列成候选。
 */
function profileNameCandidates(agent: {
  id: string;
  slug: string | null;
  name: string;
}): string[] {
  const candidates = [agent.id];
  const slug = agent.slug?.trim() ?? '';
  if (slug) candidates.push(slug);
  if (/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(slug)) return candidates;
  const fromName = agent.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const alnumId = agent.id.replace(/[^a-zA-Z0-9]/g, '');
  const derived = fromName || (alnumId ? `agent-${alnumId.slice(0, 16)}` : 'agent');
  candidates.push(derived);
  // 同名画像在花名册里会加 id 后缀去重（`buildMentionDelegateRoster`）。
  if (alnumId) candidates.push(`${derived}-${alnumId.slice(0, 8)}`);
  return candidates;
}

/**
 * 把画像名（slug / 派生名 / lineage id）映射回智能体记录，调用方据此取显示名
 * 与颜色。没有匹配（编排六件套的子代理、已删除的智能体）时返回 undefined，
 * 由调用方退回画像原文。
 *
 * @param profileOrId `child_spawned.profile`、`subagent_type`，或六件套的 lineage childId。
 * @param agents 当前会话可见的智能体列表。
 */
export function findAgentForProfile<
  T extends { id: string; slug: string | null; name: string },
>(profileOrId: string, agents: ReadonlyArray<T>): T | undefined {
  return agents.find((agent) =>
    profileNameCandidates(agent).includes(profileOrId),
  );
}

const STATUS_MAP: Record<string, OrchestrationTaskStatus> = {
  running: 'running',
  completed: 'ok',
  failed: 'failed',
  cancelled: 'skipped',
  // Interrupted = paused-but-resumable; renders as pending (not terminal).
  interrupted: 'pending',
  // Blocked on the user: still open, and not something 「继续」 can resolve.
  needs_input: 'ask_user_paused',
};

/**
 * Pure projection of the live child list onto the card model — the card
 * itself is click-tested in `@steerable/agent-ui`.
 */
export function childrenToCardModel(children: ChildInfo[]): {
  payload: OrchestrationPlanPayload;
  taskStatuses: Record<string, OrchestrationTaskStatus>;
} {
  return {
    payload: {
      mode: 'parallel',
      tasks: children.map((c) => ({
        id: c.childId,
        // 委派子代理显示其 profile 名(如 researcher / general-purpose);
        // 编排六件套的子代理没有 profile,退回 lineage childId。
        agentId: c.profile ?? c.childId,
        prompt: c.task ?? '',
      })),
    },
    taskStatuses: Object.fromEntries(
      children.map((c) => [c.childId, STATUS_MAP[c.status] ?? 'pending']),
    ),
  };
}

/**
 * 子代理看板只在「不止一个孩子」时有用。单次 `delegate_subagent` 已经
 * 出现在工具行「委派 ·」，再画「编排计划 · 1 个子任务」是同一件事。
 */
export function shouldShowOrchestrationBoard(children: ChildInfo[]): boolean {
  return children.length >= 2;
}

/**
 * Fold the accumulated raw sidecar `agent.child` lifecycle events (as
 * forwarded by the backend's `orchestration_child` SSE payload) back into a
 * `ChildInfo[]`. Used to rebuild the in-flight child list when re-attaching
 * to a running turn (where the original event stream was consumed by a now
 * unmounted view).
 */
export function foldOrchestrationChildEvents(
  events: ReadonlyArray<Record<string, unknown>>,
): ChildInfo[] {
  // Spawn timestamps by childId: the elapsed time is only known when a
  // terminal event arrives, and nothing else records when the child started.
  const spawnedAtMs = new Map<string, number>();
  let list: ChildInfo[] = [];
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    list = applyChildEvent(list, ev, spawnedAtMs);
  }
  return list;
}

/**
 * Fold one `agent.child` event into the live child list.
 *
 * The live stream and a replay must read an event the same way, or the panel
 * shows one thing while streaming and another after a reload. `spawnedAtMs`
 * carries the spawn clock across calls; omit it for a one-shot fold and the
 * elapsed column simply stays empty.
 *
 * @param list The children accumulated so far.
 * @param ev One `agent.child` lifecycle payload.
 * @param spawnedAtMs Spawn timestamps by childId (mutated).
 * @returns The list after this event.
 */
export function applyChildEvent(
  list: ChildInfo[],
  ev: Record<string, unknown>,
  spawnedAtMs: Map<string, number> = new Map(),
): ChildInfo[] {
  const kind = typeof ev.kind === 'string' ? ev.kind : '';
  const childId = typeof ev.childId === 'string' ? ev.childId : '';
  if (!kind || !childId) return list;
  const idx = list.findIndex((c) => c.childId === childId);
  if (kind === 'child_spawned') {
    if (idx >= 0) return list;
    spawnedAtMs.set(childId, typeof ev.atMs === 'number' ? ev.atMs : Date.now());
    return [
      ...list,
      {
        childId,
        task: typeof ev.task === 'string' ? ev.task : undefined,
        depth: typeof ev.depth === 'number' ? ev.depth : undefined,
        ...(typeof ev.profile === 'string' ? { profile: ev.profile } : {}),
        // 子代理自己的 durable record：委派行靠它跳转右侧过程栏。
        ...(typeof ev.recordId === 'string' ? { recordId: ev.recordId } : {}),
        // R2: the fork re-read the parent prefix on another model. A hint,
        // not an error — the spawn still succeeded.
        ...(ev.cacheNote === 'cold' ? { cacheNote: 'cold' as const } : {}),
        ...(typeof ev.parentModel === 'string' ? { parentModel: ev.parentModel } : {}),
        ...(typeof ev.childModel === 'string' ? { childModel: ev.childModel } : {}),
        status: 'running',
      },
    ];
  }
  if (idx < 0) return list;
  if (kind === 'child_needs_input') {
    // The child stopped and is waiting on the user. It is not running and it
    // is not settled — marking it `interrupted` would offer 「继续」, which is
    // wrong: what it needs is an answer.
    const next = [...list];
    next[idx] = {
      ...list[idx],
      status: 'needs_input',
      needsInput: { intro: typeof ev.intro === 'string' ? ev.intro : '' },
      handedOver: undefined,
    };
    return next;
  }
  const status =
    kind === 'child_completed'
      ? 'completed'
      : kind === 'child_failed'
        ? 'failed'
        : kind === 'child_cancelled'
          ? 'cancelled'
          : kind === 'child_interrupted'
            ? 'interrupted'
            : kind === 'child_resumed'
              ? 'running'
              : list[idx].status;
  const next = [...list];
  next[idx] = {
    ...list[idx],
    status,
    ...(isChildUsage(ev.usage) ? { usage: ev.usage } : {}),
    ...elapsedOf(spawnedAtMs.get(childId), ev),
  };
  return next;
}

/** Statuses `agent_send` can continue. `closed` is deliberately absent. */
const RESUMABLE_CHILD_STATUSES = new Set([
  'completed',
  'interrupted',
  'cancelled',
  'budget_exhausted',
]);

/**
 * The child a question came from, for the ask-user card's source line.
 *
 * Returns the first row waiting on the user: the host shows one card at a
 * time, so "which child asked" has exactly one answer while a card is open.
 *
 * @param children This turn's children.
 * @returns The child that asked, or null when nothing is waiting.
 */
export function childAwaitingInput(
  children: readonly ChildInfo[],
): ChildInfo | null {
  return children.find((child) => Boolean(child.needsInput)) ?? null;
}

/**
 * Whether 「继续」 applies to this child.
 *
 * Derived from the status rather than stored: a resumed child goes back to
 * `running`, and a stored flag would have to be cleared on every resume.
 * `needs_input` is deliberately absent — that child is waiting for an
 * answer, and resuming it would just ask the same question again.
 *
 * @param child The child row.
 * @returns True when `agent_send` can continue it.
 */
export function isChildResumable(child: ChildInfo): boolean {
  if (child.needsInput) return false;
  return RESUMABLE_CHILD_STATUSES.has(child.status);
}

function isChildUsage(
  value: unknown,
): value is { promptTokens: number; completionTokens: number; totalTokens: number } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.promptTokens === 'number'
    && typeof record.completionTokens === 'number'
    && typeof record.totalTokens === 'number'
  );
}

/**
 * How long the child ran, when both ends carry a wall clock.
 *
 * Both are required: replaying a turn persisted before `atMs` existed would
 * otherwise report a zero-length run, which reads as "it did nothing".
 */
function elapsedOf(
  spawnedAtMs: number | undefined,
  ev: Record<string, unknown>,
): { elapsedMs?: number } {
  if (spawnedAtMs === undefined) return {};
  const atMs = typeof ev.atMs === 'number' ? ev.atMs : undefined;
  if (atMs === undefined) return {};
  const elapsed = atMs - spawnedAtMs;
  return elapsed >= 0 ? { elapsedMs: elapsed } : {};
}

/**
 * Mark a child's question as handed over once the parent has re-delegated.
 *
 * The old row keeps existing (it is a real delegation that ran), but it must
 * stop saying 「等待你的回答」 — the user answered, and the work continued in a
 * new child. Without this the panel shows two rows both waiting on the user.
 *
 * @param list The children accumulated so far.
 * @param childId The child that asked.
 * @returns The list with that child marked handed over.
 */
export function markChildHandedOver(
  list: ChildInfo[],
  childId: string,
): ChildInfo[] {
  const idx = list.findIndex((child) => child.childId === childId);
  if (idx < 0 || !list[idx].needsInput) return list;
  const next = [...list];
  next[idx] = { ...list[idx], status: 'completed', handedOver: true, needsInput: undefined };
  return next;
}

/**
 * 从助手消息 `messageMetadata.orchestrationChildEvents` 水合子代理卡片。
 * 刷新后没有 live SSE，只能靠落库事件经 `foldOrchestrationChildEvents` 重建。
 */
export function extractPersistedOrchestrationChildren(
  messages:
    | ReadonlyArray<{
        id: string;
        role?: string;
        messageMetadata?: string | null;
      }>
    | undefined,
): Record<string, ChildInfo[]> {
  const seeded: Record<string, ChildInfo[]> = {};
  if (!messages || messages.length === 0) return seeded;
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.messageMetadata) continue;
    try {
      const metadata = JSON.parse(message.messageMetadata) as {
        orchestrationChildEvents?: unknown;
      };
      if (!Array.isArray(metadata.orchestrationChildEvents)) continue;
      const events = metadata.orchestrationChildEvents.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item),
      );
      const list = foldOrchestrationChildEvents(events);
      if (list.length > 0) seeded[message.id] = list;
    } catch {
      // Ignore malformed legacy metadata.
    }
  }
  return seeded;
}

/**
 * 把注册表里的子代理并进重启后的面板（R7-2）。
 *
 * 落库的 `orchestrationChildEvents` 只覆盖「回合跑到了收尾」的情形：进程被杀
 * 时最后一条 assistant 消息可能根本没落库，那些子代理只存在于注册表里。没有
 * 这一步，用户重开后看到的比实际派出去的少。
 *
 * 已经出现在某条消息里的子代理不重复添加（事件流比注册行更新）。剩下的挂到
 * 最后一条 assistant 消息上——那是这个会话最近一次派发的归处；会话里一条
 * assistant 消息都没有时（首个回合就被杀）返回空，因为没有面板可挂。
 *
 * @param persisted 落库事件水合出的「消息 id → 子代理」。
 * @param orderedMessageIds 会话消息按时间顺序的 id。
 * @param sessionChildren 注册表返回的本会话子代理。
 * @returns 合并后的映射；未变化时返回原对象。
 */
export function mergeSessionChildren(
  persisted: Record<string, ChildInfo[]>,
  orderedMessageIds: readonly string[],
  sessionChildren: ReadonlyArray<Record<string, unknown>>,
): Record<string, ChildInfo[]> {
  if (sessionChildren.length === 0) return persisted;
  const seen = new Set<string>();
  for (const list of Object.values(persisted)) {
    for (const child of list) seen.add(child.childId);
  }
  const unseen = sessionChildren
    .map(toChildInfo)
    .filter((child): child is ChildInfo => child !== null && !seen.has(child.childId));
  if (unseen.length === 0) return persisted;
  const target = [...orderedMessageIds].reverse().find((id) => id in persisted)
    ?? undefined;
  if (target === undefined) return persisted;
  return {
    ...persisted,
    [target]: [...persisted[target], ...unseen],
  };
}

/**
 * 注册行 → 面板行。
 *
 * 注册行没有任务文本（那是子代理自己的记录），也没有耗时；状态已经是合成
 * 结果（`interrupted` 表示行未终结且本进程没有活句柄），正好是面板要的。
 *
 * @param raw `agent.children.list` 的一行。
 * @returns 面板行；缺 childId 时返回 null。
 */
function toChildInfo(raw: Record<string, unknown>): ChildInfo | null {
  const childId = typeof raw.childId === 'string' ? raw.childId : '';
  if (!childId) return null;
  const status = typeof raw.status === 'string' ? raw.status : 'interrupted';
  const prompt = typeof raw.promptTokens === 'number' ? raw.promptTokens : null;
  const completion =
    typeof raw.completionTokens === 'number' ? raw.completionTokens : null;
  return {
    childId,
    status,
    ...(typeof raw.depth === 'number' ? { depth: raw.depth } : {}),
    ...(typeof raw.profile === 'string' ? { profile: raw.profile } : {}),
    ...(typeof raw.recordId === 'string' ? { recordId: raw.recordId } : {}),
    // `usageKnown: false` 是外部引擎：它跑过，但没人计过 token。
    ...(raw.usageKnown === false
      ? {}
      : prompt !== null || completion !== null
        ? {
            usage: {
              promptTokens: prompt ?? 0,
              completionTokens: completion ?? 0,
              totalTokens: (prompt ?? 0) + (completion ?? 0),
            },
          }
        : {}),
  };
}
