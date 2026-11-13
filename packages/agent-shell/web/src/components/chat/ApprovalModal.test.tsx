/**
 * ApprovalModalHost 的网络出口（network_egress）分支契约（W-egress-ask）：
 *   - category=network_egress 的请示以「请求访问外网」标题 + host:port
 *     展示，并带仿冒域名警示；
 *   - 「始终」变体对网络出口隐藏（代理白名单是会话寿命的进程级状态，
 *     持久放行要走设置的出网白名单，不是这个模态）；
 *   - 普通工具调用的 7 变体行为不回归。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalPromptRequest } from '@/lib/host-bridge';
import { configureI18n, registerLocale, resetI18nForTests } from '@/i18n/runtime';
import { ApprovalPromptMenu } from './ApprovalModal';

afterEach(() => {
  cleanup();
  resetI18nForTests();
});

const EGRESS_REQUEST: ApprovalPromptRequest = {
  requestId: 'req-egress',
  toolName: 'network_egress',
  arguments: { host: 'cdn.example.com', port: 443, url: 'https://cdn.example.com/x.js' },
  mode: 'other',
  category: 'network_egress',
  round: 0,
};

const SHELL_REQUEST: ApprovalPromptRequest = {
  requestId: 'req-shell',
  toolName: 'bash',
  arguments: { command: 'rm -rf /tmp/x' },
  mode: 'destructive',
  category: 'bash',
  round: 0,
};

const SANDBOX_ESCALATION_REQUEST: ApprovalPromptRequest = {
  requestId: 'req-sandbox-escalation',
  toolName: 'local_exec_shell',
  arguments: { command: 'rm -rf ~/.local/share/python-runner' },
  mode: 'destructive',
  category: 'sandbox_escalation',
  round: 1,
};

describe('ApprovalModalHost 网络出口分支（W-egress-ask）', () => {
  it('以 host:port 标题 + 仿冒警示展示，并隐藏「始终」变体', () => {
    render(
      <ApprovalPromptMenu request={EGRESS_REQUEST} pendingCount={0} onDecide={vi.fn()} />,
    );

    expect(screen.getByText('Agent requests internet access')).toBeTruthy();
    expect(screen.getByText('cdn.example.com:443')).toBeTruthy();
    expect(screen.getByText(/lookalike domains/)).toBeTruthy();
    // 会话档保留，「始终」档隐藏。
    expect(screen.getByText('Allow once')).toBeTruthy();
    expect(screen.getByText('Allow for this chat')).toBeTruthy();
    expect(screen.queryByText('Always allow')).toBeNull();
    expect(screen.queryByText('Always deny')).toBeNull();
  });

  it('普通工具调用的 7 变体不回归', () => {
    const onDecide = vi.fn();
    render(
      <ApprovalPromptMenu request={SHELL_REQUEST} pendingCount={1} onDecide={onDecide} />,
    );

    expect(screen.getByText('Agent requests to run')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('1 more awaiting approval')).toBeTruthy();
    expect(screen.getByText('Always allow')).toBeTruthy();
    expect(screen.getByText('Always deny')).toBeTruthy();
    expect(screen.getByText(/workspace sandbox/)).toBeTruthy();
    fireEvent.click(screen.getByText('Allow once'));
    expect(onDecide).toHaveBeenCalledWith('allow_once');
  });

  it('沙盒拒绝后询问是否在工作区外重试', () => {
    render(
      <ApprovalPromptMenu
        request={SANDBOX_ESCALATION_REQUEST}
        pendingCount={0}
        onDecide={vi.fn()}
      />,
    );

    expect(screen.getByText('Agent requests to run a command outside the workspace')).toBeTruthy();
    expect(screen.getByText('rm -rf ~/.local/share/python-runner')).toBeTruthy();
    expect(screen.getByText(/The workspace sandbox blocked this command/)).toBeTruthy();
    expect(screen.queryByText(/switch the sandbox to/)).toBeNull();
    expect(screen.queryByText(/about 2 minutes/)).toBeNull();
  });

  it('names a shared category on the allow buttons and explains browser actions', () => {
    render(
      <ApprovalPromptMenu
        request={{
          requestId: 'req-browser',
          toolName: 'browser_navigate',
          arguments: { url: 'https://www.example.com/about' },
          mode: 'external',
          category: 'browser',
          categoryLabel: 'Browser actions',
          round: 0,
        }}
        pendingCount={0}
        onDecide={vi.fn()}
      />,
    );

    expect(screen.getByText('Agent requests to open a page')).toBeTruthy();
    expect(screen.getByText('browser_navigate')).toBeTruthy();
    expect(screen.getByText('(Browser actions)')).toBeTruthy();
    expect(screen.getByText('Allow Browser actions for this chat')).toBeTruthy();
    expect(screen.getByText('Always allow Browser actions')).toBeTruthy();
    expect(screen.getByText(/Scrolling, reading, and screenshots do not need approval/)).toBeTruthy();
    expect(screen.queryByText(/about 2 minutes/)).toBeNull();
    expect(screen.queryByText(/lookalike domains/)).toBeNull();
  });

  it('translates the browser category when the interface is Chinese', () => {
    registerLocale('zh', {
      'Browser actions': '浏览器操作',
      '({category})': '（{category}）',
      'Allow {category} for this chat': '本会话允许{category}',
      'Always allow {category}': '始终允许{category}',
      'Allow once': '允许一次',
      'Agent requests to run': 'Agent 请求执行',
      'Agent requests to open a page': 'Agent 请求打开网页',
    });
    configureI18n({
      locales: ['en', 'zh'],
      defaultLocale: 'zh',
      systemLocale: 'zh',
      storage: { getItem: () => null, setItem: () => undefined },
    });
    render(
      <ApprovalPromptMenu
        request={{
          requestId: 'req-browser-zh',
          toolName: 'browser_navigate',
          arguments: { url: 'https://www.example.com/about' },
          mode: 'external',
          category: 'browser',
          categoryLabel: 'Browser actions',
          round: 0,
        }}
        pendingCount={0}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText('Agent 请求打开网页')).toBeTruthy();
    expect(screen.getByText('（浏览器操作）')).toBeTruthy();
    expect(screen.getByText('本会话允许浏览器操作')).toBeTruthy();
    expect(screen.getByText('始终允许浏览器操作')).toBeTruthy();
    expect(screen.queryByText('Browser actions')).toBeNull();
  });

  it('explains an out-of-project shell without the egress warning', () => {
    render(
      <ApprovalPromptMenu
        request={{
          requestId: 'req-outside',
          toolName: 'local_exec_shell',
          arguments: { command: 'unzip report.zip', cwd: '~/Downloads' },
          mode: 'destructive',
          category: 'local_exec_shell',
          categoryLabel: 'Command',
          outsideWorkspace: true,
          round: 0,
        }}
        pendingCount={0}
        onDecide={vi.fn()}
      />,
    );

    expect(screen.getByText('(Command)')).toBeTruthy();
    expect(screen.getByText(/Working directory ~\/Downloads is outside the project/)).toBeTruthy();
    expect(screen.queryByText(/lookalike domains/)).toBeNull();
    expect(screen.getByText('Allow for this chat')).toBeTruthy();
    expect(screen.queryByText(/about 2 minutes/)).toBeNull();
  });

  it('translates the out-of-project shell explanation', () => {
    registerLocale('zh', {
      Command: '命令',
      '({category})': '（{category}）',
      'Agent requests to run': 'Agent 请求执行',
      'The command runs in the sandbox. Working directory {cwd} is outside the project, so writes there are blocked. Add that directory as a project source folder when a write is required.':
        '命令在沙箱中运行，工作目录 {cwd} 不在项目内，写入该目录会被拒绝。需要写入时，把它加为项目的源文件夹。',
    });
    configureI18n({
      locales: ['en', 'zh'],
      defaultLocale: 'zh',
      systemLocale: 'zh',
      storage: { getItem: () => null, setItem: () => undefined },
    });
    render(
      <ApprovalPromptMenu
        request={{
          requestId: 'req-outside-zh',
          toolName: 'local_exec_shell',
          arguments: { command: 'unzip report.zip', cwd: '~/Downloads' },
          mode: 'destructive',
          category: 'local_exec_shell',
          categoryLabel: 'Command',
          outsideWorkspace: true,
          round: 0,
        }}
        pendingCount={0}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText('（命令）')).toBeTruthy();
    expect(screen.getByText(
      '命令在沙箱中运行，工作目录 ~/Downloads 不在项目内，写入该目录会被拒绝。需要写入时，把它加为项目的源文件夹。',
    )).toBeTruthy();
    expect(screen.queryByText(/lookalike domains/)).toBeNull();
    expect(screen.queryByText(/约 2 分钟/)).toBeNull();
  });

  it('explains an outside cwd in a chat that has no project', () => {
    render(
      <ApprovalPromptMenu
        request={{
          requestId: 'req-workspace',
          toolName: 'local_exec_shell',
          arguments: { command: 'unzip report.zip', cwd: '~/Downloads' },
          mode: 'destructive',
          category: 'local_exec_shell',
          categoryLabel: 'Command',
          outsideWorkspace: true,
          outsideWorkspaceKind: 'workspace',
          round: 0,
        }}
        pendingCount={0}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText(
      'The command runs in the sandbox. Working directory ~/Downloads is outside this chat workspace, so writes there are blocked.',
    )).toBeTruthy();
    expect(screen.queryByText(/source folder/)).toBeNull();
    expect(screen.queryByText(/lookalike domains/)).toBeNull();
    expect(screen.queryByText(/约 2 分钟/)).toBeNull();
  });

  it('does not say writes are blocked when the command sandbox is off', () => {
    render(
      <ApprovalPromptMenu
        request={{
          requestId: 'req-full',
          toolName: 'local_exec_shell',
          arguments: { command: 'unzip report.zip', cwd: '~/Downloads' },
          mode: 'destructive',
          category: 'local_exec_shell',
          categoryLabel: 'Command',
          outsideWorkspace: true,
          outsideWorkspaceKind: 'workspace',
          sandboxEnforced: false,
          round: 0,
        }}
        pendingCount={0}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText('unzip report.zip')).toBeTruthy();
    expect(screen.queryByText(/writes there are blocked/)).toBeNull();
    expect(screen.queryByText(/Writes outside it are blocked/)).toBeNull();
    expect(screen.queryByText(/source folder/)).toBeNull();
  });

  it('keeps the outside-cwd explanation when the sidecar says the sandbox is on', () => {
    render(
      <ApprovalPromptMenu
        request={{
          requestId: 'req-outside-on',
          toolName: 'local_exec_shell',
          arguments: { command: 'unzip report.zip', cwd: '~/Downloads' },
          mode: 'destructive',
          category: 'local_exec_shell',
          categoryLabel: 'Command',
          outsideWorkspace: true,
          sandboxEnforced: true,
          round: 0,
        }}
        pendingCount={0}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText(/writes there are blocked/)).toBeTruthy();
    expect(screen.getByText(/source folder/)).toBeTruthy();
  });

  it('keeps the egress timeout and hides a permanent allow', () => {
    render(
      <ApprovalPromptMenu request={EGRESS_REQUEST} pendingCount={0} onDecide={vi.fn()} />,
    );
    expect(screen.getByText(/that network access fails/)).toBeTruthy();
    expect(screen.queryByText(/about 2 minutes/)).toBeNull();
  });
});
