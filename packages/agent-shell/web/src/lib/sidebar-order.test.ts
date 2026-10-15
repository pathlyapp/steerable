import { describe, expect, it } from 'vitest';
import { chatActivityTime, latestActivityTime } from './sidebar-order';

describe('chatActivityTime', () => {
  const now = Date.parse('2026-10-09T00:00:00.000Z');

  it('用最后更新时间', () => {
    expect(
      chatActivityTime('2026-10-08T00:00:00.000Z', '2026-01-01T00:00:00.000Z', undefined, now),
    ).toBe(Date.parse('2026-10-08T00:00:00.000Z'));
  });

  it('没有有效更新时间时用创建时间', () => {
    expect(chatActivityTime(null, '2026-01-01T00:00:00.000Z', undefined, now)).toBe(
      Date.parse('2026-01-01T00:00:00.000Z'),
    );
    expect(chatActivityTime('not-a-date', '2026-01-01T00:00:00.000Z', undefined, now)).toBe(
      Date.parse('2026-01-01T00:00:00.000Z'),
    );
  });

  it('进行中的回合用更新的本地时间', () => {
    const persisted = Date.parse('2026-10-01T00:00:00.000Z');
    expect(chatActivityTime('2026-10-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', now, now)).toBe(
      now,
    );
    expect(
      chatActivityTime('2026-10-08T00:00:00.000Z', '2026-01-01T00:00:00.000Z', persisted, now),
    ).toBe(Date.parse('2026-10-08T00:00:00.000Z'));
  });
});

describe('latestActivityTime', () => {
  it('取组内最近一次，空组为 0', () => {
    expect(latestActivityTime([])).toBe(0);
    expect(latestActivityTime([10, 40, 25])).toBe(40);
  });
});
