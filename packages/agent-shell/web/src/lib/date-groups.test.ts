/**
 * date-groups：侧栏会话分组的标签与排序权重。
 * 锁定分档边界（今天 / 昨天 / 2–3 天前 / 同年 M/D / 跨年 M/D/YYYY）
 * 与 priority 的单调性（越小越新）。测试日期一律相对今天构造（正午锚定），
 * 避免硬编码日期随时间腐化或在午夜前后抖动。
 */
import { describe, expect, it } from 'vitest';
import { getDateGroupLabel, getDateGroupPriority } from './date-groups';

/** 构造 n 天前的日期（锚在正午，避开跨午夜的边界抖动）。 */
function daysAgo(n: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

describe('getDateGroupLabel 分档', () => {
  it('今天与昨天有专用标签', () => {
    expect(getDateGroupLabel(daysAgo(0))).toBe('Today');
    expect(getDateGroupLabel(daysAgo(1))).toBe('Yesterday');
  });

  it('2–3 天前折叠为「N days ago」', () => {
    expect(getDateGroupLabel(daysAgo(2))).toBe('2 days ago');
    expect(getDateGroupLabel(daysAgo(3))).toBe('3 days ago');
  });

  it('4 天起按年份分档：同年 M/D，跨年 M/D/YYYY', () => {
    const d = daysAgo(10);
    const today = new Date();
    if (d.getFullYear() === today.getFullYear()) {
      expect(getDateGroupLabel(d)).toBe(`${d.getMonth() + 1}/${d.getDate()}`);
    } else {
      expect(getDateGroupLabel(d)).toBe(
        `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`,
      );
    }
  });

  it('确定的过去年份一定走跨年格式', () => {
    expect(getDateGroupLabel(new Date(2000, 0, 5))).toBe('1/5/2000');
  });
});

describe('getDateGroupPriority 排序权重', () => {
  it('各档位的权重值', () => {
    expect(getDateGroupPriority(daysAgo(0))).toBe(1);
    expect(getDateGroupPriority(daysAgo(1))).toBe(2);
    expect(getDateGroupPriority(daysAgo(3))).toBe(5);
    expect(getDateGroupPriority(new Date(2000, 0, 5))).toBe(1000);
  });

  it('同年 4 天以上走月日档', () => {
    const d = daysAgo(10);
    const expected = d.getFullYear() === new Date().getFullYear() ? 100 : 1000;
    expect(getDateGroupPriority(d)).toBe(expected);
  });

  it('按权重排序后组序为 今天 → 昨天 → N天前 → 跨年', () => {
    const dates = [new Date(2000, 0, 5), daysAgo(3), daysAgo(1), daysAgo(2), daysAgo(0)];
    const sorted = [...dates].sort(
      (a, b) => getDateGroupPriority(a) - getDateGroupPriority(b),
    );
    expect(sorted.map(getDateGroupLabel)).toEqual([
      'Today',
      'Yesterday',
      '2 days ago',
      '3 days ago',
      '1/5/2000',
    ]);
  });
});
