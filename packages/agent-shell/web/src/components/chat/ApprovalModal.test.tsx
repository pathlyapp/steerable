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
import { ApprovalPromptMenu } from './ApprovalModal';

afterEach(() => {
  cleanup();
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
  });
});
