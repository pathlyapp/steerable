/**
 * 侧栏会话与项目的显示顺序。
 * 会话按最后活动时间新到旧；项目按组内最近一次会话的活动时间，没有会话的项目留在后面。
 */

/**
 * 会话的排序时间。有效的 `updatedAt` 优先，否则用 `createdAt`。
 * `liveAt` 是进行中回合在列表刷新前的本地时间，只在比已保存时间更新时抬高。
 */
export function chatActivityTime(
  updatedAt: string | null | undefined,
  createdAt: string | null | undefined,
  liveAt?: number,
  now = Date.now(),
): number {
  const updated = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  const created = createdAt ? Date.parse(createdAt) : Number.NaN;
  const persisted = Number.isFinite(updated)
    ? updated
    : Number.isFinite(created)
      ? created
      : now;
  return liveAt !== undefined && Number.isFinite(liveAt) && liveAt > persisted
    ? liveAt
    : persisted;
}

/** 一组会话里最近的活动时间。没有会话时为 0，这样空项目排在有对话的项目后面。 */
export function latestActivityTime(times: readonly number[]): number {
  let latest = 0;
  for (const time of times) {
    if (time > latest) latest = time;
  }
  return latest;
}
