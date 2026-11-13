/**
 * 交互命令先交出会话号，下一步用 write_stdin 往同一个伪终端写，并拿到新输出。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalExecutor } from '../src/local-executor.js';
import { closeAllShellSessions, writeShellStdin } from '../src/shell-session.js';
import { ToolRouter } from '../src/tool-router.js';

const isWin = process.platform === 'win32';

const SCRIPT = `
process.stdout.write('ready\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  const text = String(chunk).replace(/\\r/g, '');
  process.stdout.write('got:' + text);
  if (text.includes('quit')) process.exit(0);
});
`;

afterEach(() => {
  closeAllShellSessions();
});

describe('shell session stdin', () => {
  it('rejects a session that was never started', async () => {
    const missing = await writeShellStdin({ sessionId: 'missing', chars: 'hi\n', yieldMs: 50 });
    expect(missing).toMatchObject({ success: false, error: 'session not found' });
  });

  it.skipIf(isWin)('writes the next input to the same session and returns the new output', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'shell-session-'));
    const script = path.join(dir, 'echo-stdin.js');
    await writeFile(script, SCRIPT);
    const executor = new LocalExecutor();
    const router = new ToolRouter(executor, { list: () => [] } as never);
    try {
      const started = await router.execute({
        name: 'local_exec_shell',
        arguments: {
          command: `node ${JSON.stringify(script)}`,
          cwd: dir,
          pty: true,
          yieldMs: 8000,
        },
      });
      expect(started).toMatchObject({ success: true, stillRunning: true, pty: true });
      const sessionId = (started as { sessionId?: string }).sessionId ?? '';
      expect(sessionId).not.toBe('');
      expect((started as { stdout?: string }).stdout).toContain('ready');

      const written = await router.execute({
        name: 'write_stdin',
        arguments: { sessionId, chars: 'hello\n', yieldMs: 4000 },
      });
      expect(written).toMatchObject({ success: true, running: true });
      expect((written as { stdout?: string }).stdout).toContain('got:hello');

      const polled = await router.execute({
        name: 'write_stdin',
        arguments: { sessionId, chars: '', yieldMs: 200 },
      });
      expect(polled).toMatchObject({ success: true, running: true });

      const finished = await router.execute({
        name: 'write_stdin',
        arguments: { sessionId, chars: 'quit\n', yieldMs: 4000 },
      });
      expect((finished as { stdout?: string }).stdout).toContain('got:quit');
      expect((finished as { running?: boolean }).running).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
