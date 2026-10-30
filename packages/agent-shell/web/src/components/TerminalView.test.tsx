import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalView } from './TerminalView';

const xterm = vi.hoisted(() => {
  const constructed: Array<{ fontSize?: number }> = [];
  const term = { cols: 80, rows: 24 };
  const fit = vi.fn(() => {
    term.cols = 110;
    term.rows = 28;
  });
  return { constructed, term, fit };
});

const host = vi.hoisted(() => {
  const listeners = new Set<(payload: { scale: number }) => void>();
  const resize = vi.fn(async () => undefined);
  const ensure = vi.fn(async () => ({
    id: 'pty-1',
    shell: '/bin/zsh',
    pid: 7,
    cwd: '/tmp/repo',
    cols: 80,
    rows: 24,
  }));
  return { listeners, resize, ensure };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    constructor(options: { fontSize?: number }) {
      xterm.constructed.push(options);
      xterm.term.cols = this.cols;
      xterm.term.rows = this.rows;
      Object.defineProperty(this, 'cols', {
        get: () => xterm.term.cols,
        set: (value: number) => {
          xterm.term.cols = value;
        },
      });
      Object.defineProperty(this, 'rows', {
        get: () => xterm.term.rows,
        set: (value: number) => {
          xterm.term.rows = value;
        },
      });
    }
    loadAddon() {}
    open() {}
    onData() {
      return { dispose() {} };
    }
    attachCustomKeyEventHandler() {}
    writeln() {}
    write() {}
    dispose() {}
    getSelection() {
      return '';
    }
    paste() {}
    clearSelection() {}
    selectAll() {}
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {
      xterm.fit();
    }
    proposeDimensions() {
      return { cols: xterm.term.cols, rows: xterm.term.rows };
    }
  },
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

vi.mock('@/lib/host-bridge', () => ({
  getHostBridge: () => ({
    terminal: {
      ensure: host.ensure,
      resize: host.resize,
      onData: () => () => undefined,
      onExit: () => () => undefined,
    },
    onZoomChanged: (callback: (payload: { scale: number }) => void) => {
      host.listeners.add(callback);
      return () => host.listeners.delete(callback);
    },
  }),
}));

afterEach(() => {
  cleanup();
  host.listeners.clear();
  host.resize.mockClear();
  host.ensure.mockClear();
  xterm.fit.mockClear();
  xterm.constructed.length = 0;
  xterm.term.cols = 80;
  xterm.term.rows = 24;
});

describe('TerminalView', () => {
  it('缩放后按可见区域重排行列，字号仍是 13', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    render(<TerminalView />);
    await waitFor(() => expect(host.ensure).toHaveBeenCalled());
    expect(xterm.constructed[0]?.fontSize).toBe(13);
    expect(host.resize).not.toHaveBeenCalled();
    act(() => {
      for (const listener of host.listeners) listener({ scale: 1.5 });
    });
    expect(frames).toHaveLength(1);
    act(() => {
      frames[0]?.(0);
    });
    expect(xterm.fit).toHaveBeenCalled();
    expect(host.resize).toHaveBeenCalledWith('pty-1', 110, 28);
  });
});
