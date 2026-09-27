/**
 * 会话目标。每个 chat 一份，写在用户数据目录的 goals.json。
 *
 * 修订号做乐观并发：update_goal 必须带上一次读到的 revision。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getUserDataDir } from './runtime.js';

export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete';

export type GoalAction = 'edit' | 'pause' | 'resume' | 'complete' | 'blocked';

export const GOAL_ACTIONS: readonly GoalAction[] = [
  'edit',
  'pause',
  'resume',
  'complete',
  'blocked',
];

export interface StoredGoal {
  id: string;
  chatId: string;
  revision: number;
  objective: string;
  phase: GoalPhase;
  blockedReason?: string;
  updatedAt: number;
}

interface FileShape {
  goals: Record<string, StoredGoal>;
}

export interface GoalToolResult {
  success: boolean;
  goal?: StoredGoal | null;
  error?: string;
  needsFollowup?: boolean;
}

export class GoalStore {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  static default(): GoalStore {
    return new GoalStore(path.join(getUserDataDir(), 'goals.json'));
  }

  async get(chatId: string): Promise<GoalToolResult> {
    const data = await this.load();
    return { success: true, goal: data.goals[chatId] ?? null };
  }

  async create(chatId: string, objective: string): Promise<GoalToolResult> {
    const text = objective.trim();
    if (!text) return { success: false, error: 'objective 不能为空', needsFollowup: true };
    return this.queue(async () => {
      const data = await this.read();
      const existing = data.goals[chatId];
      if (existing && existing.phase !== 'complete') {
        return {
          success: false,
          error: `本会话已有未完成目标（${existing.id}，revision ${existing.revision}）。先 update_goal 完成或改写它。`,
          goal: existing,
          needsFollowup: true,
        };
      }
      const goal: StoredGoal = {
        id: randomUUID(),
        chatId,
        revision: 1,
        objective: text,
        phase: 'active',
        updatedAt: Date.now(),
      };
      data.goals[chatId] = goal;
      await this.write(data);
      return { success: true, goal };
    });
  }

  async update(input: {
    chatId: string;
    id: string;
    revision: number;
    action: string;
    objective?: string;
    reason?: string;
  }): Promise<GoalToolResult> {
    if (!GOAL_ACTIONS.includes(input.action as GoalAction)) {
      return {
        success: false,
        error: `action 必须是 ${GOAL_ACTIONS.join(' | ')}`,
        needsFollowup: true,
      };
    }
    const action = input.action as GoalAction;
    return this.queue(async () => {
      const data = await this.read();
      const current = data.goals[input.chatId];
      if (!current || current.id !== input.id) {
        return { success: false, error: '目标不存在或 id 不匹配。先 get_goal。', needsFollowup: true };
      }
      if (current.revision !== input.revision) {
        return {
          success: false,
          error: `revision 已变（当前 ${current.revision}）。重新 get_goal 后再更新。`,
          goal: current,
          needsFollowup: true,
        };
      }
      const next = applyAction(current, action, input.objective, input.reason);
      if ('error' in next) return { success: false, error: next.error, goal: current, needsFollowup: true };
      data.goals[input.chatId] = next;
      await this.write(data);
      return { success: true, goal: next };
    });
  }

  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.pending.then(fn, fn);
    this.pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<FileShape> {
    return this.queue(() => this.read());
  }

  private async read(): Promise<FileShape> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as FileShape;
      if (!parsed || typeof parsed !== 'object' || !parsed.goals) return { goals: {} };
      return parsed;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { goals: {} };
      throw err;
    }
  }

  private async write(data: FileShape): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
}

function applyAction(
  current: StoredGoal,
  action: GoalAction,
  objective: string | undefined,
  reason: string | undefined,
): StoredGoal | { error: string } {
  const next: StoredGoal = { ...current, revision: current.revision + 1, updatedAt: Date.now() };
  if (action === 'edit') {
    const text = objective?.trim() ?? '';
    if (!text) return { error: 'edit 需要 objective' };
    next.objective = text;
    return next;
  }
  if (action === 'pause') {
    if (current.phase !== 'active') return { error: `只有 active 目标可以暂停（当前 ${current.phase}）` };
    next.phase = 'paused';
    return next;
  }
  if (action === 'resume') {
    if (current.phase !== 'paused' && current.phase !== 'blocked') {
      return { error: `只有 paused 或 blocked 目标可以恢复（当前 ${current.phase}）` };
    }
    next.phase = 'active';
    delete next.blockedReason;
    return next;
  }
  if (action === 'complete') {
    if (current.phase === 'complete') return { error: '目标已经完成' };
    next.phase = 'complete';
    return next;
  }
  const text = reason?.trim() ?? '';
  if (!text) return { error: 'blocked 需要 reason' };
  if (current.phase !== 'active' && current.phase !== 'paused') {
    return { error: `当前阶段 ${current.phase} 不能标为 blocked` };
  }
  next.phase = 'blocked';
  next.blockedReason = text;
  return next;
}
