import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZoomToast } from './ZoomToast';

const host = vi.hoisted(() => {
  const listeners = new Set<(payload: { scale: number }) => void>();
  return {
    listeners,
    setZoom: vi.fn(async (scale: number) => scale),
    bridge: {
      getZoom: async () => 1,
      setZoom: (scale: number) => host.setZoom(scale),
      onZoomChanged: (callback: (payload: { scale: number }) => void) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    },
  };
});

vi.mock('@/lib/host-bridge', () => ({
  getHostBridge: () => host.bridge,
}));

afterEach(() => {
  cleanup();
  host.listeners.clear();
  host.setZoom.mockClear();
  vi.useRealTimers();
});

describe('ZoomToast', () => {
  it('shows the percent and hides it after 1.5s', () => {
    vi.useFakeTimers();
    render(<ZoomToast />);
    expect(screen.queryByTestId('zoom-toast')).toBeNull();
    expect(host.listeners.size).toBe(1);
    act(() => {
      for (const listener of host.listeners) listener({ scale: 1.2 });
    });
    expect(screen.getByTestId('zoom-toast').textContent).toContain('120%');
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(screen.getByTestId('zoom-toast')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId('zoom-toast')).toBeNull();
  });

  it('resets to actual size from the toast', () => {
    render(<ZoomToast />);
    act(() => {
      for (const listener of host.listeners) listener({ scale: 1.5 });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(host.setZoom).toHaveBeenCalledWith(1);
  });
});
