import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { TmuxDriver } from './tmux-driver.js';

const root = path.resolve(import.meta.dirname, '..');
const entry = path.join(root, 'dist/tui/smoke-entry.js');

describe.skipIf(!TmuxDriver.isAvailable())('tui tmux smoke', () => {
  beforeAll(() => {
    const built = spawnSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(built.status, built.stdout + built.stderr).toBe(0);
  });

  it('TUI-001 opens the TUI for a bare CLI invocation in a PTY', async () => {
    const driver = new TmuxDriver({ caseId: 'TUI-001-default-cli', cwd: root });
    driver.start(process.execPath, [entry, '--default-cli']);
    try {
      const screen = await driver.waitFor('/help');
      expect(screen).toContain('demo-model');
      expect(screen).not.toContain('Usage:');
      driver.send('C-c');
      await driver.waitUntilGone();
    } catch (error) {
      await driver.writeFailureArtifacts(error);
      throw error;
    } finally {
      driver.kill();
    }
  });

  it('TUI-003 TUI-004 TUI-041 TUI-081 TUI-085 approves, interrupts, exits, and restores the PTY', async () => {
    const driver = new TmuxDriver({ caseId: 'TUI-PTY-smoke', cwd: root });
    driver.start(`/bin/sh -c '${process.execPath} ${entry}; exec /bin/sh -i'`);
    try {
      expect(await driver.waitFor('中断')).toContain('中断');
      driver.send('hello', 'Enter');
      expect(await driver.waitFor('审批')).toContain('local_exec_shell');
      driver.send('y');
      expect(await driver.waitFor('listed')).toContain('listed');
      driver.send('/goal ship demo', 'Enter');
      expect(await driver.waitFor('goal wake completed')).toContain('目标续跑');
      driver.send('/loop 1s monitor demo until complete', 'Enter');
      expect(await driver.waitFor('loop monitoring pending')).toContain('Loop 触发');
      const completedLoop = await driver.waitFor('loop reached terminal state');
      expect(completedLoop).not.toContain('Loop · 1 个运行中');
      driver.send('/loop 1s recurring demo', 'Enter');
      expect(await driver.waitFor('Loop · 1 个运行中')).toContain('loop armed loop-recurring');
      driver.send('/loop stop loop-recurring', 'Enter');
      expect(await driver.waitFor('Loop 已停止')).not.toContain('Loop · 1 个运行中');
      driver.send('hang', 'Enter');
      expect(await driver.waitFor('running')).toContain('running');
      driver.send('C-c');
      expect(await driver.waitFor('已中断')).toContain('已中断');
      driver.send('C-c');
      await driver.waitForScreen((screen) => !screen.includes('已中断'), 'TUI screen to close');
      await driver.waitFor('sh-');
      driver.send('echo __TUI_RESTORED__', 'C-m');
      const restored = await driver.waitForScreen(
        (screen) => (screen.match(/__TUI_RESTORED__/g)?.length ?? 0) >= 2,
        'restored shell output',
      );
      expect(restored).toContain('__TUI_RESTORED__');
      expect(driver.format('#{cursor_flag}')).toBe('1');
      driver.send('exit', 'C-m');
      await driver.waitUntilGone();
    } catch (error) {
      await driver.writeFailureArtifacts(error);
      throw error;
    } finally {
      driver.kill();
    }
  }, 20_000);
});
