/**
 * 侧栏项目分组和输入框「关联到项目」共用这一份列表。
 * 任一侧新建、改名或改目录后调用 refresh，其它订阅者一起更新。
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { hasHostBridge } from '@/lib/host-bridge';
import { hostToolChrome } from '@/lib/host-tools';
import { listProjects, reorderProjects, type LocalProject } from '@/lib/local-api';
import { applyProjectIdOrder } from '@/lib/project-order';

type ProjectsSnapshot = {
  projects: LocalProject[];
  error: string | null;
};

const EMPTY_SNAPSHOT: ProjectsSnapshot = { projects: [], error: null };

let snapshot: ProjectsSnapshot = EMPTY_SNAPSHOT;
let requestSeq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeProjects(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getProjectsSnapshot(): ProjectsSnapshot {
  return snapshot;
}

/** 重新拉取项目列表并通知所有订阅者。非 Electron 或关掉项目入口时清空。 */
export async function refreshProjects(): Promise<void> {
  const seq = ++requestSeq;
  if (!hasHostBridge() || !hostToolChrome('projects')) {
    if (snapshot.projects.length > 0 || snapshot.error) {
      snapshot = EMPTY_SNAPSHOT;
      emit();
    }
    return;
  }
  try {
    const res = await listProjects();
    if (seq !== requestSeq) return;
    snapshot = { projects: res.projects ?? [], error: null };
    emit();
  } catch (err) {
    if (seq !== requestSeq) return;
    const message = err instanceof Error ? err.message : String(err);
    console.error('Failed to load projects:', err);
    snapshot = { projects: snapshot.projects, error: message };
    emit();
  }
}

/**
 * 立刻按 orderedIds 重排共享列表，再写到服务端。
 * 保存失败时把列表滚回拖拽前的顺序，并抛出原来的错误。
 */
export async function persistProjectOrder(orderedIds: string[]): Promise<void> {
  const previous = snapshot;
  const seq = ++requestSeq;
  snapshot = {
    projects: applyProjectIdOrder(previous.projects, orderedIds),
    error: previous.error,
  };
  emit();
  try {
    const res = await reorderProjects(orderedIds);
    if (seq !== requestSeq) return;
    snapshot = {
      projects: Array.isArray(res.projects) ? res.projects : snapshot.projects,
      error: null,
    };
    emit();
  } catch (err) {
    if (seq !== requestSeq) return;
    snapshot = previous;
    emit();
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export function useProjects(): {
  projects: LocalProject[];
  error: string | null;
  refresh: () => Promise<void>;
} {
  const current = useSyncExternalStore(
    subscribeProjects,
    getProjectsSnapshot,
    getProjectsSnapshot,
  );
  useEffect(() => {
    void refreshProjects();
  }, []);
  const refresh = useCallback(() => refreshProjects(), []);
  return { projects: current.projects, error: current.error, refresh };
}

/** 测试隔离：丢掉上一个用例留下的列表，并忽略还在飞的请求。 */
export function resetProjectsStoreForTests(): void {
  requestSeq += 1;
  snapshot = EMPTY_SNAPSHOT;
  emit();
}
