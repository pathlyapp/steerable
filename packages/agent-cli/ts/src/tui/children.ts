export interface ChildRow {
  id: string;
  task: string;
  profile: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  depth: number;
}

export interface ChildEvent {
  kind?: unknown;
  childId?: unknown;
  task?: unknown;
  profile?: unknown;
  depth?: unknown;
}

/** Fold one `orchestration_child` lifecycle event into the live sub-agent list. */
export function applyChildEvent(children: readonly ChildRow[], event: ChildEvent): ChildRow[] {
  const kind = typeof event.kind === 'string' ? event.kind : '';
  const id = typeof event.childId === 'string' ? event.childId : '';
  if (!kind || !id) return [...children];
  const next = children.map((child) => ({ ...child }));
  const index = next.findIndex((child) => child.id === id);
  if (kind === 'child_spawned') {
    if (index >= 0) return next;
    next.push({
      id,
      task: typeof event.task === 'string' ? event.task : '',
      profile: typeof event.profile === 'string' ? event.profile : '',
      depth: typeof event.depth === 'number' ? Math.max(0, event.depth) : 0,
      status: 'running',
    });
    return next;
  }
  const current = next[index];
  if (!current) return next;
  next[index] = { ...current, status: childStatus(kind, current.status) };
  return next;
}

export function childLines(children: readonly ChildRow[]): string[] {
  if (children.length === 0) return [];
  const done = children.filter((child) => child.status === 'completed').length;
  const lines = [`子任务 ${done}/${children.length}`];
  for (const child of children) {
    const name = child.profile || '子任务';
    const task = child.task ? `  ${child.task}` : '';
    const indent = '  '.repeat(Math.min(child.depth, 6));
    lines.push(`${indent}${statusMark(child.status)} ${name}${task}  ${statusLabel(child.status)}`);
  }
  return lines;
}

function childStatus(kind: string, current: ChildRow['status']): ChildRow['status'] {
  if (kind === 'child_completed') return 'completed';
  if (kind === 'child_failed') return 'failed';
  if (kind === 'child_cancelled') return 'cancelled';
  if (kind === 'child_interrupted') return 'interrupted';
  if (kind === 'child_resumed') return 'running';
  return current;
}

function statusMark(status: ChildRow['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'failed') return '✗';
  if (status === 'cancelled') return '·';
  if (status === 'interrupted') return '‖';
  return '▸';
}

function statusLabel(status: ChildRow['status']): string {
  if (status === 'completed') return '完成';
  if (status === 'failed') return '失败';
  if (status === 'cancelled') return '已取消';
  if (status === 'interrupted') return '已暂停';
  return '进行中';
}
