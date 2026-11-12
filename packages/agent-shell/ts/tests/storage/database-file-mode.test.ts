/**
 * The local database holds the provider API key in plain text, so its file
 * mode is part of the credential's protection: another local account must not
 * be able to read it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { closeStorage, initializeStorage, LOCAL_SCOPE } from '../../src/storage/driver.js';

const dirs: string[] = [];
const previous = process.env.DEEPPATH_USER_DATA_DIR;

afterEach(async () => {
  await closeStorage();
  if (previous === undefined) delete process.env.DEEPPATH_USER_DATA_DIR;
  else process.env.DEEPPATH_USER_DATA_DIR = previous;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** @returns The permission bits of one file, or null when it does not exist. */
function modeOf(file: string): number | null {
  if (!fs.existsSync(file)) return null;
  return fs.statSync(file).mode & 0o777;
}

describe.skipIf(process.platform === 'win32')('database file mode', () => {
  it('is readable only by its owner once settings hold a key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-shell-mode-'));
    dirs.push(dir);
    process.env.DEEPPATH_USER_DATA_DIR = dir;
    const driver = await initializeStorage();
    const store = driver.scoped(LOCAL_SCOPE);
    await store.setLlmSettings({
      provider: 'openai-compat',
      vendorId: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'sk-should-not-be-world-readable',
    });
    await closeStorage();

    const dbPath = path.join(dir, 'agent-shell.db');
    expect(modeOf(dbPath)).toBe(0o600);
    // WAL and shared-memory files carry the same rows; tighten them too when
    // SQLite left them behind.
    for (const suffix of ['-wal', '-shm']) {
      const mode = modeOf(`${dbPath}${suffix}`);
      if (mode !== null) expect(mode).toBe(0o600);
    }
  });
});
