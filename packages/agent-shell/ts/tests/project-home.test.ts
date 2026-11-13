/**
 * 项目默认家目录：Documents/<应用名>/<项目名>/，重名追加 -2。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import {
  allocateProjectHome,
  appProjectsRoot,
  chatWorkspacePath,
  CHAT_WORKSPACES_DIR,
  ensureChatWorkspace,
  ensureWritableRoots,
  expandUserPath,
  sanitizeProjectDirName,
} from '../src/project-home.js';

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('expandUserPath', () => {
  it('展开 ~ 与 ~/…，其它路径只 trim', () => {
    expect(expandUserPath('~')).toBe(os.homedir());
    expect(expandUserPath('~/src')).toBe(path.join(os.homedir(), 'src'));
    expect(expandUserPath('  /tmp/a  ')).toBe('/tmp/a');
  });
});

describe('sanitizeProjectDirName', () => {
  it('去掉路径分隔符与尾部点，空白名回落未命名', () => {
    expect(sanitizeProjectDirName('  a/b:c  ')).toBe('a-b-c');
    expect(sanitizeProjectDirName('foo.')).toBe('foo');
    expect(sanitizeProjectDirName('   ')).toBe('未命名项目');
  });
});

describe('allocateProjectHome', () => {
  it('落在 Documents/应用名/项目名，已存在则追加序号', () => {
    const documentsDir = mkdtempSync(path.join(tmpdir(), 'proj-home-'));
    temps.push(documentsDir);
    const first = allocateProjectHome('演示', {
      documentsDir,
      appFolderName: '测试助手',
    });
    expect(first).toBe(path.join(documentsDir, '测试助手', '演示'));
    mkdirSync(first, { recursive: true });
    const second = allocateProjectHome('演示', {
      documentsDir,
      appFolderName: '测试助手',
    });
    expect(second).toBe(path.join(documentsDir, '测试助手', '演示-2'));
  });

  it('appProjectsRoot 用应用显示名做父目录', () => {
    expect(appProjectsRoot({ documentsDir: '/tmp/docs', appFolderName: 'Steerable Shell' })).toBe(
      path.join('/tmp/docs', 'Steerable Shell'),
    );
  });
});

describe('ensureChatWorkspace', () => {
  it('落在 Documents/应用名/conversations/chatId 并创建目录', () => {
    const documentsDir = mkdtempSync(path.join(tmpdir(), 'chat-ws-'));
    temps.push(documentsDir);
    const folder = ensureChatWorkspace('chat-abc', {
      documentsDir,
      appFolderName: '测试助手',
    });
    expect(folder).toBe(
      path.join(documentsDir, '测试助手', CHAT_WORKSPACES_DIR, 'chat-abc'),
    );
    expect(folder).toBe(
      chatWorkspacePath('chat-abc', { documentsDir, appFolderName: '测试助手' }),
    );
    expect(existsSync(folder)).toBe(true);
  });
});

describe('ensureWritableRoots', () => {
  // Landlock opens every writable root when it installs its rules and bwrap
  // bind-mounts them, so a declared-but-missing root aborts the sandboxed
  // spawn. The roots a turn declares (pack workspaces, a project's source
  // folders) are names until something writes there.
  it('creates nested roots and leaves existing ones alone', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'wr-'));
    temps.push(base);
    const existing = path.join(base, 'already');
    mkdirSync(existing, { recursive: true });
    const deep = path.join(base, 'a', 'b', 'c');

    const result = ensureWritableRoots([existing, deep]);

    expect(result).toEqual([existing, deep]);
    expect(existsSync(deep)).toBe(true);
    expect(existsSync(existing)).toBe(true);
  });

  it('keeps a root it cannot create in the list so the sandbox still refuses', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'wr-'));
    temps.push(base);
    // A regular file where a directory has to go: mkdir cannot succeed.
    const blocker = path.join(base, 'file');
    mkdirSync(path.dirname(blocker), { recursive: true });
    writeFileSync(blocker, '');
    const impossible = path.join(blocker, 'child');

    const result = ensureWritableRoots([impossible]);

    expect(result).toEqual([impossible]);
    expect(existsSync(impossible)).toBe(false);
  });

  it('skips blank entries', () => {
    expect(ensureWritableRoots(['', '   '])).toEqual(['', '   ']);
  });
});
