import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { log, restoreLogConsole, silenceLogConsole } from '../src/log.js';

describe('log console', () => {
  afterEach(() => {
    restoreLogConsole();
  });

  it('writes routine lines only to the log file after a routine silence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-log-'));
    const previous = process.env.DEEPPATH_USER_DATA_DIR;
    process.env.DEEPPATH_USER_DATA_DIR = dir;
    const original = { info: console.info, error: console.error };
    const printed: string[] = [];
    console.info = (line: string) => printed.push(`info ${line}`);
    console.error = (line: string) => printed.push(`error ${line}`);
    try {
      silenceLogConsole('routine');
      log.info('[terminal] spawned', { id: 't1' });
      log.error('[sidecar] failed');
      silenceLogConsole('all');
      log.error('[sidecar] failed again');
      restoreLogConsole();
      log.info('[terminal] after');
      expect(printed.map((line) => line.replace(/^(\w+) \S+ /, '$1 '))).toEqual([
        'error [error] [sidecar] failed',
        'info [info] [terminal] after',
      ]);
      const file = fs.readFileSync(path.join(dir, 'logs', 'main.log'), 'utf8');
      expect(file).toContain('[terminal] spawned {"id":"t1"}');
      expect(file).toContain('[sidecar] failed again');
    } finally {
      console.info = original.info;
      console.error = original.error;
      if (previous === undefined) delete process.env.DEEPPATH_USER_DATA_DIR;
      else process.env.DEEPPATH_USER_DATA_DIR = previous;
    }
  });
});
