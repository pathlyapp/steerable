/**
 * 二期 R4 —— 网络失败的统计口径（纯逻辑）。
 *
 * 与 `usage-summary.ts` 同样的拆分理由：`LocalStore` 顶层加载的
 * better-sqlite3 native 模块与 vitest 运行时二进制不兼容，SQL 留在
 * store 里，口径与派生量放这里，可以直接单测。
 *
 * 三个终态分开数，因为它们回答不同的问题：
 *
 * - `failed` 是要修的东西。失败率的分母用它。
 * - `cancelled` 是用户自己的决定，**不算失败**。把停止算成失败，会让
 *   「网络在变差」和「用户等得不耐烦」看起来一样。
 * - `recoveredByRetry` 是重试有没有用的直接度量：重试过、最终成功了
 *   的回合数。它低不代表重试没价值（可能是网络好），但配合失败数看就
 *   能判断 R3 的策略是否合适。
 *
 * 早于这三列存在之前写入的行，`outcome` 取默认值 `completed`——那时候
 * 也没观测过终态，按完成计是唯一诚实的读法。
 */

/** Provider failure classification, as `LLMError.kind` names them. */
export type FailureKind =
  | 'transport'
  | 'rate_limit'
  | 'server'
  | 'auth'
  | 'invalid_request'
  | 'context_overflow'
  | 'unknown';

/** One failure category with its count. */
export interface FailureKindCount {
  kind: string;
  count: number;
}

/** Reliability numbers for one window. */
export interface ReliabilitySummary {
  sinceDays: number;
  /** Every recorded turn in the window, whatever its outcome. */
  total: number;
  failed: number;
  cancelled: number;
  /** Completed turns in which at least one model request was retried. */
  recoveredByRetry: number;
  /** Turns whose model request went direct instead of through a proxy. */
  usedDirect: number;
  /** Failure counts per provider classification, largest first. */
  failuresByKind: FailureKindCount[];
}

/**
 * Share of turns that failed, as a number in [0, 1].
 *
 * Cancelled turns are excluded from the denominator: the user stopping is not
 * evidence about the network. Returns null when nothing was observed, so a
 * reader can tell "no failures" from "no data" — a dashboard that shows 0%
 * on an empty window invites the wrong conclusion.
 */
export function failureRate(summary: ReliabilitySummary): number | null {
  const observed = summary.total - summary.cancelled;
  if (observed <= 0) return null;
  return summary.failed / observed;
}

/**
 * The network-attributable share of failures, in [0, 1], or null when there
 * were none. `transport` is the kind this phase's work targets; the rest are
 * configuration (`auth`), throttling, or the provider's own errors.
 */
export function networkFailureShare(summary: ReliabilitySummary): number | null {
  if (summary.failed <= 0) return null;
  const transport = summary.failuresByKind.find((row) => row.kind === 'transport');
  return (transport?.count ?? 0) / summary.failed;
}
