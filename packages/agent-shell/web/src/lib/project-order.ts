/**
 * 侧栏项目拖拽排序。显示顺序以列表下标为准；服务端再把同样的 id
 * 顺序写成 sortOrder。
 */

export type ProjectDropPlace = 'before' | 'after';

/**
 * 把 fromId 插到 targetId 前面或后面。顺序没有变化时返回 null，
 * 调用方就不必再请求保存。
 */
export function nextProjectOrder(
  ids: readonly string[],
  fromId: string,
  targetId: string,
  place: ProjectDropPlace,
): string[] | null {
  if (!fromId || fromId === targetId) return null;
  const without = ids.filter((id) => id !== fromId);
  const targetIndex = without.indexOf(targetId);
  if (targetIndex < 0) return null;
  const insertAt = place === 'before' ? targetIndex : targetIndex + 1;
  const next = without.slice();
  next.splice(insertAt, 0, fromId);
  if (next.length === ids.length && next.every((id, index) => id === ids[index])) return null;
  return next;
}

/** 按 orderedIds 重排。名单里没有的项目保持原先的相对顺序，接在后面。 */
export function applyProjectIdOrder<T extends { id: string }>(
  projects: readonly T[],
  orderedIds: readonly string[],
): Array<T & { sortOrder: number }> {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const next: Array<T & { sortOrder: number }> = [];
  const seen = new Set<string>();
  for (const id of orderedIds) {
    const project = byId.get(id);
    if (!project || seen.has(id)) continue;
    seen.add(id);
    next.push({ ...project, sortOrder: next.length });
  }
  for (const project of projects) {
    if (seen.has(project.id)) continue;
    next.push({ ...project, sortOrder: next.length });
  }
  return next;
}
