/**
 * 会话目标。每个 chat 一份，写在用户数据目录的 goals.json。
 *
 * 修订号做乐观并发：update_goal 必须带上一次读到的 revision。
 * 模型与用户的可用动作不同（见 `MODEL_GOAL_ACTIONS`）：恢复与改写目标
 * 只能由用户发起，模型不能自己把暂停或阻塞的目标重新激活。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getUserDataDir } from './runtime.js';
import { fileLockPath } from './storage/process-locks.js';
import { acquireWriteLease } from './storage/write-lease.js';

export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete';

export type GoalAction = 'edit' | 'pause' | 'resume' | 'complete' | 'blocked';

export type GoalActor = 'model' | 'user';

export const GOAL_ACTIONS: readonly GoalAction[] = [
  'edit',
  'pause',
  'resume',
  'complete',
  'blocked',
];

/** update_goal 对模型开放的动作。 */
export const MODEL_GOAL_ACTIONS: readonly GoalAction[] = ['pause', 'complete', 'blocked'];

/** 用户（路由 / 命令）可用的动作；blocked 只由模型在阻塞核对后设置。 */
export const USER_GOAL_ACTIONS: readonly GoalAction[] = ['edit', 'pause', 'resume', 'complete'];

export interface StoredGoal {
  id: string;
  chatId: string;
  revision: number;
  objective: string;
  phase: GoalPhase;
  blockedReason?: string;
  /** 目标存在期间跑过的回合数，含用户消息回合与自动续跑回合。 */
  turns: number;
  createdAt: number;
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

export type GoalChangeListener = (chatId: string, goal: StoredGoal | null) => void;

export class GoalStore {
  private pending: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<GoalChangeListener>();

  constructor(private readonly filePath: string) {}

  static default(): GoalStore {
    return new GoalStore(path.join(getUserDataDir(), 'goals.json'));
  }

  /**
   * 订阅本实例写入的目标变化（创建、更新、清除、回合计数）。
   * @returns 取消订阅
   */
  onChange(listener: GoalChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
      const now = Date.now();
      const goal: StoredGoal = {
        id: randomUUID(),
        chatId,
        revision: 1,
        objective: text,
        phase: 'active',
        turns: 0,
        createdAt: now,
        updatedAt: now,
      };
      data.goals[chatId] = goal;
      await this.write(data);
      this.emit(chatId, goal);
      return { success: true, goal };
    });
  }

  async update(input: {
    chatId: string;
    id: string;
    revision: number;
    action: string;
    actor: GoalActor;
    objective?: string;
    reason?: string;
  }): Promise<GoalToolResult> {
    const allowed = input.actor === 'model' ? MODEL_GOAL_ACTIONS : USER_GOAL_ACTIONS;
    if (!allowed.includes(input.action as GoalAction)) {
      return {
        success: false,
        error: `action 必须是 ${allowed.join(' | ')}`,
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
      this.emit(input.chatId, next);
      return { success: true, goal: next };
    });
  }

  /** 删除本会话的目标记录（用户 `/goal clear`）。 */
  async clear(chatId: string): Promise<GoalToolResult> {
    return this.queue(async () => {
      const data = await this.read();
      if (!data.goals[chatId]) return { success: true, goal: null };
      delete data.goals[chatId];
      await this.write(data);
      this.emit(chatId, null);
      return { success: true, goal: null };
    });
  }

  /**
   * 给仍是 `goalId` 的目标记一回合。不改 revision：回合发生在两次模型
   * 读写之间，计数不应让模型手里的 revision 失效。
   */
  async recordTurn(chatId: string, goalId: string): Promise<StoredGoal | null> {
    return this.queue(async () => {
      const data = await this.read();
      const current = data.goals[chatId];
      if (!current || current.id !== goalId) return null;
      const next: StoredGoal = { ...current, turns: current.turns + 1, updatedAt: Date.now() };
      data.goals[chatId] = next;
      await this.write(data);
      this.emit(chatId, next);
      return next;
    });
  }

  private emit(chatId: string, goal: StoredGoal | null): void {
    for (const listener of this.listeners) {
      try {
        listener(chatId, goal);
      } catch (err) {
        console.warn('[goal-store] change listener failed', err);
      }
    }
  }

  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const runLocked = async () => {
      const lease = acquireWriteLease(fileLockPath(getUserDataDir(), 'goals'), 5_000);
      try {
        return await fn();
      } finally {
        lease.release();
      }
    };
    const run = this.pending.then(runLocked, runLocked);
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
      for (const goal of Object.values(parsed.goals)) {
        goal.turns ??= 0;
        goal.createdAt ??= goal.updatedAt;
      }
      return parsed;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { goals: {} };
      throw err;
    }
  }

  private async write(data: FileShape): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(tmp, this.filePath);
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
