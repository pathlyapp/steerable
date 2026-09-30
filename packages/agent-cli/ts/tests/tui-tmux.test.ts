import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const session = `agent-tui-${process.pid}`;

describe('tui tmux smoke', () => {
  it('approves one turn and interrupts the next', () => {
    const built = spawnSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(built.status, built.stdout + built.stderr).toBe(0);
    const entry = path.join(root, 'dist/tui/smoke-entry.js');
    spawnSync('tmux', ['kill-session', '-t', session], { encoding: 'utf8' });
    const started = spawnSync('tmux', [
      'new-session', '-d', '-s', session, '-x', '100', '-y', '32',
      process.execPath, entry,
    ], { encoding: 'utf8' });
    expect(started.status, started.stderr).toBe(0);
    try {
      expect(waitFor('中断')).toContain('中断');
      send('hello', 'Enter');
      expect(waitFor('审批')).toContain('local_exec_shell');
      send('y');
      expect(waitFor('listed')).toContain('listed');
      send('/goal ship demo', 'Enter');
      expect(waitFor('goal wake completed')).toContain('目标续跑');
      send('/loop 1s monitor demo until complete', 'Enter');
      expect(waitFor('loop monitoring pending')).toContain('Loop 触发');
      const completedLoop = waitFor('loop reached terminal state');
      expect(completedLoop).not.toContain('Loop · 1 个运行中');
      send('/loop 1s recurring demo', 'Enter');
      expect(waitFor('Loop · 1 个运行中')).toContain('loop armed loop-recurring');
      send('/loop stop loop-recurring', 'Enter');
      expect(waitFor('Loop 已停止')).not.toContain('Loop · 1 个运行中');
      send('hang', 'Enter');
      expect(waitFor('running')).toContain('running');
      send('C-c');
      expect(waitFor('已中断')).toContain('已中断');
      spawnSync('sleep', ['0.3']);
      send('C-c');
      const exited = waitUntilGone();
      expect(exited).toBe(true);
    } finally {
      spawnSync('tmux', ['kill-session', '-t', session], { encoding: 'utf8' });
    }
  }, 20_000);
});

function send(...keys: string[]): void {
  const result = spawnSync('tmux', ['send-keys', '-t', session, ...keys], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}

function capture(): string {
  const result = spawnSync('tmux', ['capture-pane', '-p', '-t', session], { encoding: 'utf8' });
  return result.stdout ?? '';
}

function waitFor(text: string): string {
  const started = Date.now();
  let pane = '';
  while (Date.now() - started < 5000) {
    pane = capture();
    if (pane.includes(text)) return pane;
    spawnSync('sleep', ['0.05']);
  }
  throw new Error(`timed out waiting for ${text}\n${pane}`);
}

function waitUntilGone(): boolean {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const result = spawnSync('tmux', ['has-session', '-t', session], { encoding: 'utf8' });
    if (result.status !== 0) return true;
    spawnSync('sleep', ['0.05']);
  }
  return false;
}
