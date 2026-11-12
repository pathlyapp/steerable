import { describe, expect, it } from 'vitest';
import { resumableTurn } from '../../src/local-backend/resumable-turn.js';

// 「继续」的准入：中断、失败、用户停止三种可以续跑，正常完成的不行。
const base = {
  turnActive: false,
  streamActive: false,
  lastMessageRole: 'assistant' as string | null,
  lastAssistantStatus: null as string | null,
};

describe('resumableTurn', () => {
  it('崩溃/强杀：标记残留且没有助手回复 → 可续跑', () => {
    expect(
      resumableTurn({ ...base, turnActive: true, lastMessageRole: 'user' }),
    ).toBe('interrupted');
  });

  it('首轮就失败（标记已清，助手消息记 failed）→ 可续跑', () => {
    expect(resumableTurn({ ...base, lastAssistantStatus: 'failed' })).toBe('failed');
  });

  it('用户停止的回合 → 可续跑，因为多半是等不急而不是放弃任务', () => {
    expect(resumableTurn({ ...base, lastAssistantStatus: 'cancelled' })).toBe('cancelled');
  });

  it('正常完成的回合 → 不可续跑，否则会凭空多接一段回复', () => {
    expect(resumableTurn({ ...base, lastAssistantStatus: 'completed' })).toBeNull();
  });

  it('没有状态字段的旧记录 → 不可续跑，不猜', () => {
    expect(resumableTurn({ ...base })).toBeNull();
  });

  it('本轮正在跑 → 一律不可续跑，避免两个写者交错同一条记录', () => {
    expect(
      resumableTurn({
        ...base,
        streamActive: true,
        lastAssistantStatus: 'failed',
      }),
    ).toBeNull();
  });

  it('标记残留但回复已落库：终态以回复为准，失败的仍可续跑', () => {
    expect(
      resumableTurn({ ...base, turnActive: true, lastAssistantStatus: 'failed' }),
    ).toBe('failed');
    expect(
      resumableTurn({ ...base, turnActive: true, lastAssistantStatus: 'completed' }),
    ).toBeNull();
  });

  it('会话末尾不是助手回复、也没有残留标记 → 不可续跑', () => {
    expect(resumableTurn({ ...base, lastMessageRole: 'user' })).toBeNull();
    expect(resumableTurn({ ...base, lastMessageRole: null })).toBeNull();
  });

  it('空会话残留标记（首轮首次 flush 前崩溃）→ 可续跑', () => {
    expect(
      resumableTurn({ ...base, turnActive: true, lastMessageRole: null }),
    ).toBe('interrupted');
  });
});
