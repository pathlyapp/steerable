/**
 * 「网络不稳定，正在重新连接」状态行：文案在 10 秒后才显示已等待时长，
 * 数字每秒刷新，并且它优先于「正在思考」和流式光标。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RETRY_ELAPSED_VISIBLE_MS, RetryStatus, retryLabel } from './RetryStatus';
import { StreamingStatus } from './StreamingStatus';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('retryLabel', () => {
  const startedAt = 1_000_000;

  it('10 秒内不显示秒数——短等待读作进展，读秒读作故障', () => {
    expect(retryLabel(startedAt, startedAt + 0)).toBe('Network unstable, reconnecting…');
    expect(retryLabel(startedAt, startedAt + RETRY_ELAPSED_VISIBLE_MS - 1)).toBe(
      'Network unstable, reconnecting…',
    );
  });

  it('10 秒后显示已等待的整秒数', () => {
    expect(retryLabel(startedAt, startedAt + RETRY_ELAPSED_VISIBLE_MS)).toBe(
      'Network unstable, reconnecting… (10s)',
    );
    expect(retryLabel(startedAt, startedAt + 14_800)).toBe(
      'Network unstable, reconnecting… (14s)',
    );
  });

  it('时钟落后于开始时间时不报负数', () => {
    expect(retryLabel(startedAt, startedAt - 5_000)).toBe('Network unstable, reconnecting…');
  });
});

describe('RetryStatus', () => {
  it('出现时就在状态行里，并带 role=status', () => {
    const startedAt = 1_000_000;
    render(<RetryStatus retry={{ startedAt }} now={() => startedAt} />);
    const line = screen.getByTestId('retry-status');
    expect(line.getAttribute('role')).toBe('status');
    expect(line.textContent).toContain('reconnecting');
  });

  it('每秒刷新已等待时长', () => {
    vi.useFakeTimers();
    const startedAt = 1_000_000;
    let clock = startedAt + RETRY_ELAPSED_VISIBLE_MS;
    render(<RetryStatus retry={{ startedAt }} now={() => clock} />);
    expect(screen.getByTestId('retry-status').textContent).toContain('(10s)');

    clock += 5_000;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId('retry-status').textContent).toContain('(15s)');
  });

  it('卸载后停止计时', () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(window, 'clearInterval');
    const startedAt = 1_000_000;
    const { unmount } = render(<RetryStatus retry={{ startedAt }} />);
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });
});

describe('StreamingStatus 与重试', () => {
  it('重试时显示重新连接，而不是正在思考', () => {
    render(<StreamingStatus round={1} actionCount={0} hasContent={false} retry={{ startedAt: Date.now() }} />);
    expect(screen.getByTestId('retry-status')).toBeTruthy();
    expect(screen.queryByText('Now thinking...')).toBeNull();
  });

  it('已有正文时重试提示仍然显示——光标不能说明它在等', () => {
    render(
      <StreamingStatus
        round={2}
        actionCount={3}
        hasContent
        retry={{ startedAt: Date.now() }}
      />,
    );
    expect(screen.getByTestId('retry-status')).toBeTruthy();
  });

  it('没有重试时不出现重新连接', () => {
    render(<StreamingStatus round={1} actionCount={0} hasContent={false} />);
    expect(screen.queryByTestId('retry-status')).toBeNull();
  });
});
