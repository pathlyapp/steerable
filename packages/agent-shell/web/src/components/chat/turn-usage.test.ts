/**
 * turn-usage 前端模型测试：解析 `stream.done.usage` 的形状、拆出「父级 /
 * 子代理」两段，以及两种会让合计偏小的情形必须被标出来。
 *
 * 最要紧的一条是 `partial`：外部引擎子代理报不出 token，合计只是下限。
 * 少了这个标记，用户会把一个偏小的数字当成完整账单——这正是用量面板当初
 * 加 `usageNote: 'partial'` 的原因，这里是同一个判断在回合级的投影。
 */
import { describe, expect, it } from 'vitest';

import { formatTurnTokens, parseTurnUsage, summarizeTurnUsage } from './turn-usage';

describe('parseTurnUsage', () => {
  it('合法账单原样解析', () => {
    expect(
      parseTurnUsage({
        promptTokens: 1200,
        completionTokens: 300,
        totalTokens: 1500,
        cachedPromptTokens: 800,
        costUsd: 0.02,
      }),
    ).toEqual({
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
      cachedPromptTokens: 800,
      costUsd: 0.02,
    });
  });

  it('缺 token 三项就不是账单，返回 null', () => {
    expect(parseTurnUsage({ promptTokens: 1, completionTokens: 1 })).toBeNull();
    expect(parseTurnUsage({})).toBeNull();
    expect(parseTurnUsage(null)).toBeNull();
    expect(parseTurnUsage('nope')).toBeNull();
  });

  it('负数与 NaN 视为坏数据', () => {
    expect(
      parseTurnUsage({ promptTokens: -1, completionTokens: 0, totalTokens: 0 }),
    ).toBeNull();
  });

  it('子代理分项解析；坏掉的一项被跳过而不是整份作废', () => {
    const usage = parseTurnUsage({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      children: [
        { childId: '0.1', promptTokens: 60, completionTokens: 20, totalTokens: 80 },
        { childId: '0.2', promptTokens: 'oops' },
        { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      ],
    });

    expect(usage?.children).toEqual([
      { childId: '0.1', promptTokens: 60, completionTokens: 20, totalTokens: 80 },
    ]);
  });

  it('空 children 与零 unknownUsageChildren 都不落键', () => {
    const usage = parseTurnUsage({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      children: [],
      unknownUsageChildren: 0,
    });

    expect(usage).not.toHaveProperty('children');
    expect(usage).not.toHaveProperty('unknownUsageChildren');
  });
});

describe('summarizeTurnUsage', () => {
  it('父级与子代理是两份并列账单，整轮总计相加', () => {
    // sidecar 的 usage.totalTokens 是**父代理自己的**，childTotalTokens 是
    // 子代理那一部分；两者不相交。
    const breakdown = summarizeTurnUsage({
      promptTokens: 1000,
      completionTokens: 200,
      totalTokens: 1200,
      childTotalTokens: 900,
    });

    expect(breakdown.parentTokens).toBe(1200);
    expect(breakdown.childTokens).toBe(900);
    expect(breakdown.totalTokens).toBe(2100);
    expect(breakdown.childSharePercent).toBe(43);
    expect(breakdown.hasChildren).toBe(true);
    expect(breakdown.partial).toBe(false);
  });

  it('没有子代理时总计就是父级，且不渲染子代理那一段', () => {
    const breakdown = summarizeTurnUsage({
      promptTokens: 500,
      completionTokens: 100,
      totalTokens: 600,
    });

    expect(breakdown.parentTokens).toBe(600);
    expect(breakdown.childTokens).toBe(0);
    expect(breakdown.totalTokens).toBe(600);
    expect(breakdown.hasChildren).toBe(false);
  });

  it('只有 children[] 没有合计时按分项求和', () => {
    const breakdown = summarizeTurnUsage({
      promptTokens: 300,
      completionTokens: 100,
      totalTokens: 400,
      children: [
        { childId: '0.1', promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        { childId: '0.2', promptTokens: 150, completionTokens: 30, totalTokens: 180 },
      ],
    });

    expect(breakdown.childTokens).toBe(300);
    expect(breakdown.totalTokens).toBe(700);
  });

  it('总计为 0 时占比不除零', () => {
    const breakdown = summarizeTurnUsage({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });

    expect(breakdown.childSharePercent).toBe(0);
    expect(breakdown.totalTokens).toBe(0);
  });

  it('外部引擎子代理让合计变成下限，必须标出来', () => {
    // 这一路只有 unknownUsageChildren：子代理确实花了钱，但一个数都没报。
    const breakdown = summarizeTurnUsage({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      unknownUsageChildren: 2,
    });

    expect(breakdown.partial).toBe(true);
    // 报不出用量不等于没派活：这一行必须出现，否则用户根本不知道有子代理。
    expect(breakdown.hasChildren).toBe(true);
    expect(breakdown.childTokens).toBe(0);
    expect(breakdown.totalTokens).toBe(120);
  });
});

describe('formatTurnTokens', () => {
  it('三级精简', () => {
    expect(formatTurnTokens(999)).toBe('999');
    expect(formatTurnTokens(1500)).toBe('1.5k');
    expect(formatTurnTokens(2_500_000)).toBe('2.50M');
  });

  it('坏值渲染成 0 而不是 NaN', () => {
    expect(formatTurnTokens(Number.NaN)).toBe('0');
    expect(formatTurnTokens(-5)).toBe('0');
  });
});
