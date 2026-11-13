import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../../src/log.js', () => ({
  log: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createProcessSpawnHandler } from '../../src/sidecar/reverse-spawn.js';

describe('host.process.spawn helper stderr', () => {
  const platform = process.platform;
  const previous = process.env.DEEPPATH_WIN_SPAWN_HELPER;
  let scratch = '';

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'win-spawn-helper-stderr-'));
    const helper = join(scratch, 'win-spawn-helper.exe');
    writeFileSync(helper, '');
    process.env.DEEPPATH_WIN_SPAWN_HELPER = helper;
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    if (previous === undefined) delete process.env.DEEPPATH_WIN_SPAWN_HELPER;
    else process.env.DEEPPATH_WIN_SPAWN_HELPER = previous;
    rmSync(scratch, { recursive: true, force: true });
    mocks.spawn.mockReset();
    mocks.warn.mockReset();
  });

  it('writes helper diagnostics to the host log and keeps them out of the result', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    mocks.spawn.mockReturnValue(child);
    const running = createProcessSpawnHandler()({ command: 'echo hi', policy: { writableRoots: [] } });
    child.stderr.write('job object assigned\n\n');
    child.stdout.write(`${JSON.stringify({ type: 'stdout', data: 'hi\n' })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write(`${JSON.stringify({ type: 'exit', code: 0, sandbox: { backend: 'windows-restricted-token' } })}\n`);

    expect(await running).toEqual({
      exitCode: 0,
      stdout: 'hi\n',
      stderr: '',
      truncated: false,
      sandbox: { backend: 'windows-restricted-token', enforcement: 'full' },
    });
    expect(mocks.spawn.mock.calls[0]?.[2]).toMatchObject({ stdio: ['pipe', 'pipe', 'pipe'] });
    expect(mocks.warn.mock.calls).toEqual([['[host-spawn] helper', 'job object assigned']]);
  });
});
