import { describe, expect, it } from 'vitest';
import {
  failureRate,
  networkFailureShare,
  type ReliabilitySummary,
} from '../../src/storage/reliability-summary.js';

function summary(overrides: Partial<ReliabilitySummary> = {}): ReliabilitySummary {
  return {
    sinceDays: 7,
    total: 0,
    failed: 0,
    cancelled: 0,
    recoveredByRetry: 0,
    usedDirect: 0,
    failuresByKind: [],
    ...overrides,
  };
}

describe('failureRate', () => {
  it('把停止的回合排除在分母外——用户停止不是网络变差的证据', () => {
    // 10 个回合，其中 4 个是用户自己停的，1 个失败。
    // 算进停止会得到 10%，排除后是 1/6 ≈ 16.7%。
    const rate = failureRate(summary({ total: 10, cancelled: 4, failed: 1 }));
    expect(rate).toBeCloseTo(1 / 6);
  });

  it('没有观测到任何回合时返回 null，而不是 0', () => {
    // 0 会被读成「一切正常」；null 让面板能显示「还没有数据」。
    expect(failureRate(summary())).toBeNull();
    expect(failureRate(summary({ total: 3, cancelled: 3 }))).toBeNull();
  });

  it('全部失败时为 1', () => {
    expect(failureRate(summary({ total: 2, failed: 2 }))).toBe(1);
  });

  it('没有失败时为 0', () => {
    expect(failureRate(summary({ total: 5 }))).toBe(0);
  });
});

describe('networkFailureShare', () => {
  it('算出网络类失败在全部失败中的占比', () => {
    const share = networkFailureShare(
      summary({
        total: 10,
        failed: 4,
        failuresByKind: [
          { kind: 'transport', count: 3 },
          { kind: 'auth', count: 1 },
        ],
      }),
    );
    expect(share).toBe(0.75);
  });

  it('没有网络类失败时为 0', () => {
    expect(
      networkFailureShare(
        summary({ total: 1, failed: 1, failuresByKind: [{ kind: 'auth', count: 1 }] }),
      ),
    ).toBe(0);
  });

  it('没有失败时返回 null——占比无意义', () => {
    expect(networkFailureShare(summary({ total: 3 }))).toBeNull();
  });
});
