/**
 * AssistantMessage 时间戳行：分享对话的入口从标题栏挪到最近一条助手回复
 * 时间戳行上的分享、复制、重新生成共用悬停显隐。
 *
 * 回合产物列表：turnFiles 在回合收尾后渲染到回答气泡之下（流式中不渲染）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@steerable/agent-protocol';
import type { LocalChatAgent } from '@/lib/local-api';
import { AssistantMessage } from './AssistantMessage';

vi.mock('@/lib/local-api', () => ({
  openLocalPath: vi.fn(async () => ({ success: true })),
  getLocalFileDownload: vi.fn(async () => ({
    fileName: '报告.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 1024,
    base64: 'QkFTRTY0',
  })),
}));

afterEach(cleanup);

const MESSAGE: ChatMessage = {
  id: 'm1',
  role: 'assistant',
  content: '问好完成。',
  createdAt: '2026-09-13T09:03:00.000Z',
};

describe('AssistantMessage 分享', () => {
  it('没有 onShare 时不画分享按钮', () => {
    render(
      <AssistantMessage
        message={MESSAGE}
        isStreaming={false}
        agents={[]}
        currentAgent={null}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Share chat screenshot' })).toBeNull();
  });

  it('流式中不画分享按钮', () => {
    render(
      <AssistantMessage
        message={MESSAGE}
        isStreaming
        agents={[]}
        currentAgent={null}
        onShare={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Share chat screenshot' })).toBeNull();
  });

  it('点分享会调用 onShare，成功后提示已复制', async () => {
    const onShare = vi.fn().mockResolvedValue(true);
    render(
      <AssistantMessage
        message={MESSAGE}
        isStreaming={false}
        agents={[]}
        currentAgent={null}
        onShare={onShare}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Share chat screenshot' }));
    expect(screen.getByRole('button', { name: 'Share chat screenshot' }).className).toContain(
      'group-hover/message:opacity-100',
    );
    await waitFor(() => expect(onShare).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Share chat screenshot' }).getAttribute('title')).toBe(
        'Screenshot copied to clipboard',
      ),
    );
  });
});

describe('AssistantMessage token 速度', () => {
  it('结束后把模型请求 tok/s 画在时间戳旁边', () => {
    render(
      <AssistantMessage
        message={MESSAGE}
        isStreaming={false}
        agents={[]}
        currentAgent={null}
        llmSpeed={{
          tokens: 13,
          elapsedMs: 1000,
          live: false,
          closedMs: 1000,
          requestStartedAt: null,
        }}
      />,
    );
    expect(screen.getByTestId('turn-token-speed').textContent).toBe('13 tok/s');
  });

  it('没有用时或几乎没产出时不画速度', () => {
    render(
      <AssistantMessage
        message={MESSAGE}
        isStreaming={false}
        agents={[]}
        currentAgent={null}
      />,
    );
    expect(screen.queryByTestId('turn-token-speed')).toBeNull();
  });
});

describe('AssistantMessage 回合产物列表', () => {
  it('turnFiles 非空且非流式时渲染在回答之下', () => {
    render(
      <AssistantMessage
        message={MESSAGE}
        isStreaming={false}
        agents={[]}
        currentAgent={null}
        turnFiles={[{ path: '/proj/自我介绍.pptx', kind: 'created', size: 2048 }]}
      />,
    );
    expect(screen.getByText('自我介绍.pptx')).toBeTruthy();
    expect(screen.getByText('Presentation · PPTX')).toBeTruthy();
    expect(screen.getByText('Open with')).toBeTruthy();
  });

  it('流式中不渲染产物列表（数据要等回合收尾）', () => {
    render(
      <AssistantMessage
        message={MESSAGE}
        isStreaming
        agents={[]}
        currentAgent={null}
        turnFiles={[{ path: '/proj/a.md', kind: 'created' }]}
      />,
    );
    expect(screen.queryByText('a.md')).toBeNull();
  });

  it('没有 turnFiles 时不渲染产物卡', () => {
    const { container } = render(
      <AssistantMessage
        message={MESSAGE}
        isStreaming={false}
        agents={[]}
        currentAgent={null}
      />,
    );
    expect(container.querySelector('[data-turn-files]')).toBeNull();
  });
});

const PARENT: LocalChatAgent = {
  id: 'op',
  slug: 'operator',
  name: '电脑操作员',
  icon: null,
  color: '#111111',
  description: null,
  rolePrompt: null,
  isBuiltin: true,
};

const RESEARCHER: LocalChatAgent = {
  ...PARENT,
  id: 'a1',
  slug: 'researcher',
  name: '调研员',
  color: '#2563eb',
  isBuiltin: false,
};

describe('AssistantMessage 顶栏智能体', () => {
  it('委派多人时顶栏同时显示父代理和子代理', () => {
    render(
      <AssistantMessage
        message={{ ...MESSAGE, agentId: PARENT.id }}
        isStreaming={false}
        agents={[PARENT, RESEARCHER]}
        currentAgent={PARENT}
        executedActions={[
          {
            tool: 'delegate_subagent',
            arguments: { subagent_type: 'researcher', task: '调研' },
          },
        ]}
        orchestrationChildren={[
          { childId: '0.1', profile: 'explore', status: 'running' },
        ]}
      />,
    );
    const row = screen.getByTestId('turn-agent-badges');
    expect(row.textContent).toContain('电脑操作员');
    expect(row.textContent).toContain('调研员');
    expect(row.textContent).toContain('Explore');
  });

  it('用户 @提及了谁，顶栏就显示谁，不显示内置探索', () => {
    const helper: LocalChatAgent = {
      ...PARENT,
      id: 'h1',
      slug: 'helper',
      name: '智能助手',
      color: '#8b5cf6',
      isBuiltin: false,
    };
    const planner: LocalChatAgent = {
      ...PARENT,
      id: 'p1',
      slug: 'planner',
      name: '日程规划',
      color: '#f59e0b',
      isBuiltin: false,
    };
    render(
      <AssistantMessage
        message={{ ...MESSAGE, agentId: PARENT.id }}
        isStreaming={false}
        agents={[PARENT, helper, planner]}
        currentAgent={PARENT}
        previousUser={{
          content: '@电脑操作员 @智能助手 @日程规划 你们随便做点啥',
        }}
        orchestrationChildren={[{ childId: '0.1', profile: 'explore', status: 'failed' }]}
        executedActions={[
          { tool: 'delegate_subagent', arguments: { subagent_type: 'explore', task: '探环境' } },
        ]}
      />,
    );
    const row = screen.getByTestId('turn-agent-badges');
    expect(row.textContent).toContain('电脑操作员');
    expect(row.textContent).toContain('智能助手');
    expect(row.textContent).toContain('日程规划');
    expect(row.textContent).not.toContain('Explore');
  });
});

// ---------------------------------------------------------------------------
// 失败 / 停止 / 已继续：同一个回合位置上的三种终态
// ---------------------------------------------------------------------------

function metaMessage(metadata: Record<string, unknown>): ChatMessage {
  return {
    id: 'm-fail',
    role: 'assistant',
    content: '',
    createdAt: '2026-11-05T06:00:00.000Z',
    messageMetadata: JSON.stringify(metadata),
  } as ChatMessage;
}

describe('AssistantMessage 失败与停止', () => {
  it('失败的回合：即使没有正文也有「重新生成」（P5-05）', () => {
    render(
      <AssistantMessage
        message={metaMessage({ completionStatus: 'failed', completionReason: 'transport' })}
        isStreaming={false}
        agents={[]}
        currentAgent={null}
        onRegenerate={async () => {}}
      />,
    );
    expect(screen.getByLabelText('Regenerate')).toBeTruthy();
  });

  it('停止的回合显示中性「已停止」，不是失败卡片', () => {
    render(
      <AssistantMessage
        message={metaMessage({ completionStatus: 'cancelled', completionReason: 'aborted_by_user' })}
        isStreaming={false}
        agents={[]}
        currentAgent={null}
      />,
    );
    expect(screen.getByTestId('turn-stopped')).toBeTruthy();
    expect(screen.queryByTestId('turn-failure')).toBeNull();
    expect(screen.getByText('You stopped this task.')).toBeTruthy();
  });

  it('重新连接时点停止，文案区分开来', () => {
    render(
      <AssistantMessage
        message={metaMessage({
          completionStatus: 'cancelled',
          completionReason: 'aborted_during_retry',
        })}
        isStreaming={false}
        agents={[]}
        currentAgent={null}
      />,
    );
    expect(
      screen.getByText('You stopped this task while it was reconnecting.'),
    ).toBeTruthy();
  });

  it('停止的回合可以继续（P5-04）', () => {
    const onClick = vi.fn();
    render(
      <AssistantMessage
        message={metaMessage({ completionStatus: 'cancelled' })}
        isStreaming={false}
        agents={[]}
        currentAgent={null}
        failureAction={() => ({ onClick })}
      />,
    );
    fireEvent.click(screen.getByText('Continue'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('已继续过的失败收成一行，展开仍是原卡片（P5-03）', () => {
    render(
      <AssistantMessage
        message={metaMessage({
          completionStatus: 'failed',
          completionReason: 'transport error: ConnectError',
          continuedAt: '2026-11-05T06:05:00.000Z',
        })}
        isStreaming={false}
        agents={[]}
        currentAgent={null}
      />,
    );
    expect(screen.getByTestId('continued-here')).toBeTruthy();
    // 卡片本体默认收起；点开后才是失败卡片。
    expect(screen.queryByTestId('turn-failure')).toBeNull();
    fireEvent.click(screen.getByText('Connection failed here. Continued.'));
    expect(screen.getByTestId('turn-failure')).toBeTruthy();
  });

  it('没有 continuing 标记的失败不收起', () => {
    render(
      <AssistantMessage
        message={metaMessage({ completionStatus: 'failed', completionReason: 'boom' })}
        isStreaming={false}
        agents={[]}
        currentAgent={null}
      />,
    );
    expect(screen.queryByTestId('continued-here')).toBeNull();
    expect(screen.getByTestId('turn-failure')).toBeTruthy();
  });
});
