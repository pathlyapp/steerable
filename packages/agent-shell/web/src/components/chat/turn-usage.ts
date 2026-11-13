/**
 * 回合用量（「这一轮花了多少，其中子代理占多少」）的前端模型。
 *
 * 数据源：local-backend 在回合收尾时把 sidecar 的 `stream.done.usage` 原样
 * 经 `turn_usage` SSE 事件下发，并持久化进助手消息的 messageMetadata（键
 * `usage`）供刷新后水合。
 *
 * 为什么要在前端再算「占比」而不是后端直接给：子代理行各自只带自己那一份
 * （`orchestration_child.usage`），父代理自己的花费不在任何子代理行里，
 * 所以「本回合总计 = 父级 + 子代理」这件事只有拿到整份 usage 才成立。这里
 * 只是把同一份数字拆成可展示的两段，不是重新计费。
 */

/** 一个子代理的账单，与 sidecar `usage.children[]` 同形。 */
export interface TurnChildUsage {
  childId: string;
  profile?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * 一份回合账单。
 *
 * **读法（容易读错，所以写在这里）**：`promptTokens` / `completionTokens` /
 * `totalTokens` 是**父代理自己**的花费；`child*Tokens` 与 `children[]` 是
 * 子代理那一部分，二者是**并列相加**的关系，不是「总计与其中一部分」。这是
 * sidecar `stream.done.usage` 的原有语义（R5 只在 `usage` 上追加键，没有改
 * 键的含义），所以「本回合总共花了多少」= 这两者之和。
 */
export interface TurnUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
  costUsd?: number;
  /** 子代理合计（与上面的父级数并列，不相交）。 */
  childPromptTokens?: number;
  childCompletionTokens?: number;
  childTotalTokens?: number;
  /** 每个子代理一项；外部引擎子代理不在其中（它们报不出 token）。 */
  children?: TurnChildUsage[];
  /** 报了「用量未知」的子代理数量（外部引擎）。这些花费不在合计里。 */
  unknownUsageChildren?: number;
}

function readTokenCount(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
  return raw;
}

function parseChildUsage(raw: unknown): TurnChildUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.childId !== 'string' || !rec.childId) return null;
  const promptTokens = readTokenCount(rec.promptTokens);
  const completionTokens = readTokenCount(rec.completionTokens);
  const totalTokens = readTokenCount(rec.totalTokens);
  if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
    return null;
  }
  return {
    childId: rec.childId,
    ...(typeof rec.profile === 'string' && rec.profile ? { profile: rec.profile } : {}),
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

/**
 * 解析 SSE 事件或已落库的元数据；形状不符返回 null。
 *
 * 三个 token 数是硬要求——缺了它们这条记录不构成账单；其余字段缺失只影响
 * 展示细节（`cachedPromptTokens` / `costUsd` / `children[]` 都在早期版本里
 * 不存在）。与 `parseTurnFiles` 同约定：坏数据返回 null 而不是抛。
 */
export function parseTurnUsage(raw: unknown): TurnUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const promptTokens = readTokenCount(rec.promptTokens);
  const completionTokens = readTokenCount(rec.completionTokens);
  const totalTokens = readTokenCount(rec.totalTokens);
  if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
    return null;
  }
  const children = Array.isArray(rec.children)
    ? rec.children.map(parseChildUsage).filter((child): child is TurnChildUsage => child !== null)
    : undefined;
  const cachedPromptTokens = readTokenCount(rec.cachedPromptTokens);
  const costUsd = readTokenCount(rec.costUsd);
  const childPromptTokens = readTokenCount(rec.childPromptTokens);
  const childCompletionTokens = readTokenCount(rec.childCompletionTokens);
  const childTotalTokens = readTokenCount(rec.childTotalTokens);
  const unknownUsageChildren = readTokenCount(rec.unknownUsageChildren);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(childPromptTokens !== undefined ? { childPromptTokens } : {}),
    ...(childCompletionTokens !== undefined ? { childCompletionTokens } : {}),
    ...(childTotalTokens !== undefined ? { childTotalTokens } : {}),
    ...(children && children.length > 0 ? { children } : {}),
    ...(unknownUsageChildren !== undefined && unknownUsageChildren > 0
      ? { unknownUsageChildren }
      : {}),
  };
}

export interface TurnUsageBreakdown {
  /** 父代理自己的花费（`usage.totalTokens` 原值）。 */
  parentTokens: number;
  /** 子代理合计。没有子代理时为 0。 */
  childTokens: number;
  /** 整轮总计：父级 + 子代理。 */
  totalTokens: number;
  /** 子代理占总计的百分比；总计为 0 时为 0。 */
  childSharePercent: number;
  /** 有子代理确实花了 token。 */
  hasChildren: boolean;
  /**
   * 有一个以上子代理未报用量（外部引擎），所以合计只是下限。
   * 前端必须据此加「不完整」标记，否则偏小的合计会被读成完整账单。
   */
  partial: boolean;
}

/**
 * 把一份 usage 折成可展示的三段。
 *
 * `childTotalTokens` 缺失时退化为按 `children[]` 求和——上游在只有外部引擎
 * 子代理的路径上只填 `unknownUsageChildren`，此时子代理合计确实是 0（不是
 * 「没有子代理」），`partial` 负责说明这个 0 不代表没花钱。
 */
export function summarizeTurnUsage(usage: TurnUsage): TurnUsageBreakdown {
  const summed = usage.children?.reduce((acc, child) => acc + child.totalTokens, 0);
  const childTokens = usage.childTotalTokens ?? summed ?? 0;
  const parentTokens = usage.totalTokens;
  // 父级与子代理是两份并列的账单（见 TurnUsage 注释），整轮总计是相加。
  const totalTokens = parentTokens + childTokens;
  return {
    parentTokens,
    childTokens,
    totalTokens,
    childSharePercent: totalTokens > 0 ? Math.round((childTokens / totalTokens) * 100) : 0,
    // 「派过子代理」包含报了未知用量的那些：它们一个数都没给，但确实在
    // 这一轮花了钱，所以这一行必须出现，并由 `partial` 说明合计只是下限。
    hasChildren:
      childTokens > 0 ||
      (usage.children?.length ?? 0) > 0 ||
      (usage.unknownUsageChildren ?? 0) > 0,
    partial: (usage.unknownUsageChildren ?? 0) > 0,
  };
}

/** 与面板行内一致的精简 token 数（1.2k / 3.40M）。 */
export function formatTurnTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}
