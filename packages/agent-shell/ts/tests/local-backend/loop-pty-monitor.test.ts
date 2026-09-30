import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { LoopPtyMonitor } from '../../src/local-backend/loop-pty-monitor.js';
import { TerminalManager } from '../../src/terminal-manager.js';

class FakeTerminalManager extends EventEmitter {
  readonly writes: Array<{ id: string; data: string }> = [];
  readonly killed: string[] = [];
  private nextId = 0;

  spawn() {
    this.nextId += 1;
    return {
      id: `terminal-${this.nextId}`,
      shell: '/bin/zsh',
      pid: this.nextId,
      cwd: '/tmp',
      cols: 100,
      rows: 30,
    };
  }

  write(id: string, data: string): boolean {
    this.writes.push({ id, data });
    return true;
  }

  kill(id: string): boolean {
    this.killed.push(id);
    return true;
  }
}

describe('LoopPtyMonitor', () => {
  it('starts a background shell whose first wake occurs after the interval', () => {
    const terminals = new FakeTerminalManager();
    const monitor = new LoopPtyMonitor(terminals, vi.fn());
    const loop = monitor.start({
      chatId: 'chat-1',
      prompt: 'check build',
      intervalSeconds: 5,
    });

    expect(loop).toMatchObject({
      chatId: 'chat-1',
      prompt: 'check build',
      intervalSeconds: 5,
      terminalSessionId: 'terminal-1',
    });
    expect(terminals.writes[0]?.data).toContain('while true');
    expect(terminals.writes[0]?.data).toContain('sleep 5');
    expect(terminals.writes[0]?.data.indexOf('sleep 5')).toBeLessThan(
      terminals.writes[0]?.data.indexOf('printf'),
    );
    expect(terminals.writes[0]?.data).not.toContain(`__STEERABLE_LOOP_WAKE__:${loop.id}`);
  });

  it('buffers split PTY chunks and wakes the same chat once per marker', async () => {
    const terminals = new FakeTerminalManager();
    const wake = vi.fn(async () => ({ started: true }));
    const monitor = new LoopPtyMonitor(terminals, wake);
    const loop = monitor.start({
      chatId: 'chat-1',
      prompt: 'check build',
      intervalSeconds: 5,
    });

    terminals.emit('data', loop.terminalSessionId, `noise\r\n__STEERABLE_LOOP_`);
    terminals.emit('data', loop.terminalSessionId, `WAKE__:${loop.id}\r\n`);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
    expect(wake).toHaveBeenCalledWith('chat-1', {
      trigger: 'loop',
      message: expect.stringContaining(`Loop ID: ${loop.id}`),
      sourceId: loop.id,
    });
    const message = wake.mock.calls[0]?.[1].message ?? '';
    expect(message).toContain('<loop-task>\ncheck build\n</loop-task>');
    expect(message).toContain('call loop_stop');
    expect(message).toContain('open-ended recurring work');
  });

  it('ignores markers from other terminals and retries naturally after busy', async () => {
    const terminals = new FakeTerminalManager();
    const wake = vi.fn()
      .mockResolvedValueOnce({ started: false, reason: 'busy' })
      .mockResolvedValueOnce({ started: true });
    const monitor = new LoopPtyMonitor(terminals, wake);
    const loop = monitor.start({
      chatId: 'chat-1',
      prompt: 'check build',
      intervalSeconds: 5,
    });
    const marker = `__STEERABLE_LOOP_WAKE__:${loop.id}\r\n`;

    terminals.emit('data', 'terminal-other', marker);
    terminals.emit('data', loop.terminalSessionId, marker);
    terminals.emit('data', loop.terminalSessionId, marker);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2));
  });

  it('lists by chat, stops by id, and removes exited PTYs', () => {
    const terminals = new FakeTerminalManager();
    const changed = vi.fn();
    const monitor = new LoopPtyMonitor(terminals, vi.fn(), changed);
    const left = monitor.start({ chatId: 'chat-1', prompt: 'left', intervalSeconds: 5 });
    const right = monitor.start({ chatId: 'chat-2', prompt: 'right', intervalSeconds: 10 });

    expect(monitor.list('chat-1')).toEqual([left]);
    expect(monitor.stop(left.id)).toBe(true);
    expect(terminals.killed).toEqual([left.terminalSessionId]);
    expect(monitor.list('chat-1')).toEqual([]);

    terminals.emit('exit', right.terminalSessionId, 0, null);
    expect(monitor.list()).toEqual([]);
    expect(changed).toHaveBeenCalledWith('chat-1', [left]);
    expect(changed).toHaveBeenCalledWith('chat-1', []);
    expect(changed).toHaveBeenCalledWith('chat-2', []);
  });

  it('rejects invalid intervals and disposes listeners', () => {
    const terminals = new FakeTerminalManager();
    const monitor = new LoopPtyMonitor(terminals, vi.fn());
    expect(() => monitor.start({
      chatId: 'chat-1',
      prompt: 'bad',
      intervalSeconds: 0,
    })).toThrow('intervalSeconds');
    monitor.dispose();
    expect(terminals.listenerCount('data')).toBe(0);
    expect(terminals.listenerCount('exit')).toBe(0);
  });
});

describe.skipIf(process.platform === 'win32')('LoopPtyMonitor real PTY', () => {
  it('receives repeated markers from a background shell and stops it', async () => {
    const terminals = new TerminalManager();
    const chunks: string[] = [];
    terminals.on('data', (_sessionId, chunk) => chunks.push(chunk));
    const wake = vi.fn(async () => ({ started: true as const }));
    const monitor = new LoopPtyMonitor(terminals, wake);
    try {
      const loop = monitor.start({
        chatId: 'chat-real',
        prompt: 'check real PTY',
        intervalSeconds: 1,
      });
      await vi.waitFor(() => {
        expect(wake, chunks.join('')).toHaveBeenCalledTimes(2);
      }, { timeout: 7_000 });
      expect(monitor.stop(loop.id)).toBe(true);
      expect(monitor.list('chat-real')).toEqual([]);
    } finally {
      monitor.dispose();
      terminals.killAll();
    }
  }, 9_000);
});
