import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { GoalStore, type StoredGoal } from '../src/goal-store.js';

const dirs: string[] = [];

function store(): { goals: GoalStore; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'steerable-goal-'));
  dirs.push(dir);
  const file = path.join(dir, 'goals.json');
  return { goals: new GoalStore(file), file };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function created(goals: GoalStore, chatId = 'chat-1', objective = '把测试补齐'): Promise<StoredGoal> {
  const result = await goals.create(chatId, objective);
  expect(result.success).toBe(true);
  return result.goal as StoredGoal;
}

describe('GoalStore', () => {
  it('没有目标时读到 null', async () => {
    const { goals } = store();
    expect(await goals.get('chat-1')).toEqual({ success: true, goal: null });
  });

  it('空目标被拒绝', async () => {
    const { goals } = store();
    expect(await goals.create('chat-1', '   ')).toMatchObject({
      success: false,
      needsFollowup: true,
    });
  });

  it('未完成时不能再建一个；完成后可以新建', async () => {
    const { goals } = store();
    const first = await created(goals);
    const again = await goals.create('chat-1', '另一个目标');
    expect(again.success).toBe(false);
    expect(again.goal?.id).toBe(first.id);

    const done = await goals.update({
      chatId: 'chat-1',
      id: first.id,
      revision: first.revision,
      action: 'complete',
      actor: 'model',
    });
    expect(done.goal?.phase).toBe('complete');

    const second = await created(goals, 'chat-1', '下一件');
    expect(second.id).not.toBe(first.id);
    expect(second.revision).toBe(1);
  });

  it('并发创建只有一份成功', async () => {
    const { goals } = store();
    const [left, right] = await Promise.all([
      goals.create('chat-1', '左边'),
      goals.create('chat-1', '右边'),
    ]);
    const winners = [left, right].filter((result) => result.success);
    expect(winners).toHaveLength(1);
    const current = await goals.get('chat-1');
    expect(current.goal?.objective === '左边' || current.goal?.objective === '右边').toBe(true);
  });

  it('edit、pause、blocked、resume 按阶段推进并检查修订号', async () => {
    const { goals } = store();
    const goal = await created(goals);

    expect(await goals.update({
      chatId: 'chat-1',
      id: goal.id,
      revision: goal.revision,
      action: 'edit',
      actor: 'user',
    })).toMatchObject({ success: false, error: 'edit 需要 objective' });
    expect((await goals.get('chat-1')).goal?.revision).toBe(1);

    const edited = await goals.update({
      chatId: 'chat-1',
      id: goal.id,
      revision: 1,
      action: 'edit',
      actor: 'user',
      objective: ' 改写后的目标 ',
    });
    expect(edited.goal).toMatchObject({ objective: '改写后的目标', revision: 2, phase: 'active' });

    const paused = await goals.update({
      chatId: 'chat-1',
      id: goal.id,
      revision: 2,
      action: 'pause',
      actor: 'user',
    });
    expect(paused.goal?.phase).toBe('paused');
    expect(await goals.update({
      chatId: 'chat-1',
      id: goal.id,
      revision: 3,
      action: 'pause',
      actor: 'user',
    })).toMatchObject({ success: false });

    const blocked = await goals.update({
      chatId: 'chat-1',
      id: goal.id,
      revision: 3,
      action: 'blocked',
      actor: 'model',
    });
    expect(blocked).toMatchObject({ success: false, error: 'blocked 需要 reason' });

    const withReason = await goals.update({
      chatId: 'chat-1',
      id: goal.id,
      revision: 3,
      action: 'blocked',
      actor: 'model',
      reason: '缺测试环境',
    });
    expect(withReason.goal).toMatchObject({
      phase: 'blocked',
      blockedReason: '缺测试环境',
      revision: 4,
    });

    const resumed = await goals.update({
      chatId: 'chat-1',
      id: goal.id,
      revision: 4,
      action: 'resume',
      actor: 'user',
    });
    expect(resumed.goal).toMatchObject({ phase: 'active', revision: 5 });
    expect(resumed.goal?.blockedReason).toBeUndefined();
  });

  it('过期修订号、错误 id、未知 action 都拒绝', async () => {
    const { goals } = store();
    const goal = await created(goals);
    expect(await goals.update({
      chatId: 'chat-1',
      id: goal.id,
      revision: 0,
      action: 'complete',
      actor: 'model',
    })).toMatchObject({ success: false, needsFollowup: true, goal: { revision: 1 } });
    expect(await goals.update({
      chatId: 'chat-1',
      id: 'missing',
      revision: 1,
      action: 'complete',
      actor: 'model',
    })).toMatchObject({ success: false });
    expect(await goals.update({
      chatId: 'chat-1',
      id: goal.id,
      revision: 1,
      action: 'archive',
      actor: 'model',
    })).toMatchObject({ success: false, needsFollowup: true });
    expect((await goals.get('chat-1')).goal?.phase).toBe('active');
  });

  it('会话之间互不可见，并且写到文件后重新打开仍在', async () => {
    const { goals, file } = store();
    const goal = await created(goals, 'chat-1', '只属于这一席');
    expect((await goals.get('chat-2')).goal).toBeNull();

    const reopened = new GoalStore(file);
    expect((await reopened.get('chat-1')).goal).toMatchObject({
      id: goal.id,
      objective: '只属于这一席',
      revision: 1,
      turns: 0,
    });
  });

  it('模型不能 edit 或 resume，用户不能 blocked', async () => {
    const { goals } = store();
    const goal = await created(goals);
    expect(await goals.update({
      chatId: 'chat-1',
      id: goal.id,
      revision: 1,
      action: 'edit',
      actor: 'model',
      objective: '偷偷缩小目标',
    })).toMatchObject({ success: false });

    expect(await goals.update({
      chatId: 'chat-1',
      id: goal.id,
      revision: 1,
      action: 'blocked',
      actor: 'user',
      reason: '用户不能伪造模型核对',
    })).toMatchObject({ success: false });
  });

  it('记录回合不改变 revision，clear 删除目标，并广播变化', async () => {
    const { goals } = store();
    const changes: Array<StoredGoal | null> = [];
    goals.onChange((_chatId, goal) => changes.push(goal));
    const goal = await created(goals);

    const afterTurn = await goals.recordTurn('chat-1', goal.id);
    expect(afterTurn).toMatchObject({ turns: 1, revision: 1 });
    expect((await goals.get('chat-1')).goal).toMatchObject({ turns: 1, revision: 1 });

    expect(await goals.clear('chat-1')).toEqual({ success: true, goal: null });
    expect((await goals.get('chat-1')).goal).toBeNull();
    expect(changes.map((change) => change?.turns ?? null)).toEqual([0, 1, null]);
  });
});
