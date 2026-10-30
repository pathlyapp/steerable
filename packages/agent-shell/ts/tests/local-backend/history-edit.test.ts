import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { canonicalFencePath } from '../../src/fence-path.js';
import { compactHistory, forkHistory, replacePathPrefix, rewindFrom, type StoredTurn } from '../../src/local-backend/history-edit.js';
import { forkPathRewriter } from '../../src/local-backend/fork-copy.js';
import { chatWorkspacePath } from '../../src/project-home.js';

const turns: StoredTurn[] = [
  { id: 'm4', role: 'assistant', content: '最新回答' },
  { id: 'm3', role: 'user', content: '最新问题' },
  { id: 'm2', role: 'assistant', content: '较早回答' },
  { id: 'm1', role: 'user', content: '较早问题' },
];

describe('history edit', () => {
  it('folds older turns into one summary and keeps the newest pair', () => {
    expect(compactHistory(turns.slice(0, 2))).toBeNull();
    expect(compactHistory(turns)).toEqual({
      deleteFromId: 'm1',
      compacted: 2,
      writes: [
        { role: 'assistant', content: '已压缩 2 条\nuser: 较早问题\nassistant: 较早回答', messageMetadata: null },
        { role: 'user', content: '最新问题', messageMetadata: null },
        { role: 'assistant', content: '最新回答', messageMetadata: null },
      ],
    });
  });

  it('rewinds from the newest user message and copies a fork in time order', () => {
    expect(rewindFrom(turns)).toEqual({ deleteFromId: 'm3', removed: 2 });
    expect(rewindFrom([{ id: 'a', role: 'assistant', content: '只有回答' }])).toBeNull();
    expect(forkHistory(turns).map((message) => message.content)).toEqual([
      '较早问题',
      '较早回答',
      '最新问题',
      '最新回答',
    ]);
  });

  it('replaces a path prefix and leaves a longer sibling name', () => {
    expect(replacePathPrefix('/tmp/chat/a.txt and /tmp/chat-extra/b', '/tmp/chat', '/tmp/next')).toBe(
      '/tmp/next/a.txt and /tmp/chat-extra/b',
    );
    const copied = forkHistory(
      [{ id: 'm', role: 'user', content: '/tmp/chat/a', messageMetadata: JSON.stringify({ file: '/tmp/chat/a' }) }],
      (text) => replacePathPrefix(text, '/tmp/chat', '/tmp/next'),
    );
    expect(copied[0]?.content).toBe('/tmp/next/a');
    expect(copied[0]?.messageMetadata).toBe(JSON.stringify({ file: '/tmp/next/a' }));
    expect(replacePathPrefix('/tmp/Chat/a', '/tmp/chat', '/tmp/next', 'darwin')).toBe('/tmp/Chat/a');
  });

  it('rewrites a Windows path when only case or slash direction differs', () => {
    expect(replacePathPrefix(
      'C:\\Users\\me\\OLD\\a.txt',
      'c:\\users\\me\\old',
      'D:\\next',
      'win32',
    )).toBe('D:\\next\\a.txt');
    expect(replacePathPrefix(
      'see c:/Users/me/old/a.txt',
      'C:\\Users\\me\\old',
      'C:\\Users\\me\\new',
      'win32',
    )).toBe('see C:\\Users\\me\\new/a.txt');
    expect(replacePathPrefix(
      'C:\\Users\\me\\old-extra\\a.txt',
      'C:\\Users\\me\\old',
      'C:\\Users\\me\\new',
      'win32',
    )).toBe('C:\\Users\\me\\old-extra\\a.txt');
  });

  it('rewrites a symlinked workspace by its real path', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'fork-real-'));
    const docs = path.join(parent, 'docs');
    const link = path.join(parent, 'link');
    mkdirSync(docs);
    symlinkSync(docs, link, 'dir');
    const previous = process.env.STEERABLE_DOCUMENTS_DIR;
    process.env.STEERABLE_DOCUMENTS_DIR = link;
    try {
      const rewrite = forkPathRewriter('old-chat', 'new-chat');
      const logical = chatWorkspacePath('old-chat');
      const real = canonicalFencePath(path.resolve(logical));
      const nextReal = canonicalFencePath(path.resolve(chatWorkspacePath('new-chat')));
      expect(real).not.toBe(logical);
      expect(rewrite(`${real}/a.txt`)).toBe(`${nextReal}/a.txt`);
      expect(rewrite(`${logical}/a.txt`)).toBe(`${chatWorkspacePath('new-chat')}/a.txt`);
    } finally {
      if (previous === undefined) delete process.env.STEERABLE_DOCUMENTS_DIR;
      else process.env.STEERABLE_DOCUMENTS_DIR = previous;
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
