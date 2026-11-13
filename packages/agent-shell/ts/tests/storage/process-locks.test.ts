import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireChatWriteLock,
  ChatBusyError,
} from '../../src/storage/process-locks.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('chat write lock', () => {
  it('rejects a second holder of the same chat and allows a different chat', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-lock-'));
    dirs.push(dir);
    const first = acquireChatWriteLock(dir, 'chat-a');
    const other = acquireChatWriteLock(dir, 'chat-b');
    expect(() => acquireChatWriteLock(dir, 'chat-a')).toThrow(ChatBusyError);
    first.release();
    const again = acquireChatWriteLock(dir, 'chat-a');
    again.release();
    other.release();
  });
});
