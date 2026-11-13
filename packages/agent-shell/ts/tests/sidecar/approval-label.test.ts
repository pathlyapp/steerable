import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  approvalCwdFence,
  hostApprovalCategoryLabel,
  resolveApprovalCategoryLabel,
  shellCwdOutsideProject,
} from '../../src/sidecar/approval-label.js';

const dictionary: Record<string, string> = {
  'Internet access': '出网',
  Sandbox: '沙箱',
  Command: '命令',
};

describe('resolveApprovalCategoryLabel', () => {
  it('uses a declared label for the current locale, including zh-CN under zh', () => {
    expect(resolveApprovalCategoryLabel({
      locale: 'zh',
      category: 'browser',
      toolName: 'browser_navigate',
      declaredLabel: { 'zh-CN': '浏览器操作', en: 'Browser actions' },
      translate: (message) => dictionary[message] ?? message,
    })).toBe('浏览器操作');
    expect(resolveApprovalCategoryLabel({
      locale: 'en',
      category: 'browser',
      toolName: 'browser_navigate',
      declaredLabel: { 'zh-CN': '浏览器操作', en: 'Browser actions' },
      translate: (message) => message,
    })).toBe('Browser actions');
  });

  it('sends the English source so the web card can translate it', () => {
    expect(hostApprovalCategoryLabel({
      category: 'network_egress',
      toolName: 'network_egress',
    })).toBe('Internet access');
    expect(hostApprovalCategoryLabel({
      category: 'local_exec_shell',
      toolName: 'local_exec_shell',
    })).toBe('Command');
    expect(hostApprovalCategoryLabel({
      category: 'browser',
      toolName: 'browser_navigate',
      declaredLabel: { 'zh-CN': '浏览器操作', en: 'Browser actions' },
    })).toBe('Browser actions');
  });

  it('uses the shell dictionary for built-in categories and shell tools', () => {
    const translate = (message: string) => dictionary[message] ?? message;
    expect(resolveApprovalCategoryLabel({
      locale: 'zh',
      category: 'network_egress',
      toolName: 'network_egress',
      translate,
    })).toBe('出网');
    expect(resolveApprovalCategoryLabel({
      locale: 'zh',
      category: 'local_exec_shell',
      toolName: 'local_exec_shell',
      translate,
    })).toBe('命令');
    expect(resolveApprovalCategoryLabel({
      locale: 'zh',
      category: 'local_run_snippet',
      toolName: 'local_run_snippet',
      translate,
    })).toBe('命令');
    expect(resolveApprovalCategoryLabel({
      locale: 'en',
      category: 'custom_tool',
      toolName: 'custom_tool',
      translate: (message) => message,
    })).toBeUndefined();
  });
});

describe('shellCwdOutsideProject', () => {
  it('flags a shell cwd outside the project and its source folders', () => {
    expect(shellCwdOutsideProject({
      toolName: 'local_exec_shell',
      cwd: '~/Downloads',
      projectRoot: '/work/repo',
      sourceFolders: ['/work/notes'],
      home: '/Users/me',
    })).toBe(true);
    expect(shellCwdOutsideProject({
      toolName: 'local_exec_shell',
      cwd: 'src',
      projectRoot: '/work/repo',
      sourceFolders: [],
      home: '/Users/me',
    })).toBe(false);
    expect(shellCwdOutsideProject({
      toolName: 'local_exec_shell',
      cwd: '/work/notes/a',
      projectRoot: '/work/repo',
      sourceFolders: ['/work/notes'],
      home: '/Users/me',
    })).toBe(false);
    expect(shellCwdOutsideProject({
      toolName: 'browser_navigate',
      cwd: '~/Downloads',
      projectRoot: '/work/repo',
      sourceFolders: [],
      home: '/Users/me',
    })).toBe(false);
    expect(shellCwdOutsideProject({
      toolName: 'local_run_snippet',
      cwd: '~/Downloads',
      projectRoot: '/work/repo',
      sourceFolders: [],
      home: '/Users/me',
    })).toBe(false);
    expect(shellCwdOutsideProject({
      toolName: 'local_exec_shell',
      cwd: '/work/repo/..notes',
      projectRoot: '/work/repo',
      sourceFolders: [],
      home: '/Users/me',
    })).toBe(false);
    expect(approvalCwdFence({
      toolName: 'local_exec_shell',
      cwd: '/work/repo/..notes',
      projectRoot: '/work/repo',
      workspaceRoot: null,
      sourceFolders: [],
      home: '/Users/me',
    })).toBe(false);
  });

  it('uses the conversation workspace when the chat has no project', () => {
    expect(approvalCwdFence({
      toolName: 'local_exec_shell',
      cwd: '~/Downloads',
      projectRoot: null,
      workspaceRoot: '/Users/me/Documents/Aroli/conversations/chat-1',
      sourceFolders: ['/Users/me/Downloads'],
      home: '/Users/me',
    })).toBe('workspace');
    expect(approvalCwdFence({
      toolName: 'local_exec_shell',
      cwd: 'notes',
      projectRoot: null,
      workspaceRoot: '/Users/me/Documents/Aroli/conversations/chat-1',
      sourceFolders: [],
      home: '/Users/me',
    })).toBe(false);
    expect(approvalCwdFence({
      toolName: 'local_exec_shell',
      cwd: '~/Downloads',
      projectRoot: '/work/repo',
      workspaceRoot: '/Users/me/Documents/Aroli/conversations/chat-1',
      sourceFolders: [],
      home: '/Users/me',
    })).toBe('project');
    expect(approvalCwdFence({
      toolName: 'pwsh',
      cwd: '~/Downloads',
      projectRoot: null,
      workspaceRoot: '/Users/me/Documents/Aroli/conversations/chat-1',
      sourceFolders: [],
      home: '/Users/me',
    })).toBe(false);
  });

  it('treats a symlinked cwd as inside the project', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fence-card-'));
    const linkParent = mkdtempSync(path.join(tmpdir(), 'fence-card-link-'));
    const link = path.join(linkParent, 'link');
    symlinkSync(root, link, 'dir');
    try {
      expect(shellCwdOutsideProject({
        toolName: 'local_exec_shell',
        cwd: root,
        projectRoot: realpathSync(root),
        sourceFolders: [],
      })).toBe(false);
      expect(shellCwdOutsideProject({
        toolName: 'local_exec_shell',
        cwd: link,
        projectRoot: root,
        sourceFolders: [],
      })).toBe(false);
      expect(approvalCwdFence({
        toolName: 'local_exec_shell',
        cwd: link,
        projectRoot: root,
        workspaceRoot: null,
        sourceFolders: [],
      })).toBe(false);
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('expands ~ with the process home when the caller omits home', () => {
    const projectRoot = path.join(homedir(), 'phase1-project');
    expect(shellCwdOutsideProject({
      toolName: 'local_exec_shell',
      cwd: '~/Downloads',
      projectRoot,
      sourceFolders: [],
    })).toBe(true);
    expect(shellCwdOutsideProject({
      toolName: 'local_exec_shell',
      cwd: '~',
      projectRoot: homedir(),
      sourceFolders: [],
    })).toBe(false);
  });
});
