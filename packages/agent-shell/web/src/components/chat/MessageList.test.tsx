import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@steerable/agent-protocol';
import {
  peekConversationPreview,
  resetConversationPreviewForTests,
} from '@/layouts/conversation-preview';
import { MessageList } from './MessageList';

describe('MessageList 回合吸顶结构 (Turn-based Sticky Grouping)', () => {
  it('正确将消息划分到各轮 conversation-turn 中，且用户消息容器具备 sticky 类', () => {
    const messages: ChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: '第一轮问题',
        createdAt: '2026-09-29T06:00:00.000Z',
      },
      {
        id: 'a1',
        role: 'assistant',
        content: '第一轮回复内容',
        createdAt: '2026-09-29T06:00:05.000Z',
      },
      {
        id: 'u2',
        role: 'user',
        content: '第二轮问题 1',
        createdAt: '2026-09-29T06:01:00.000Z',
      },
      {
        id: 'u3',
        role: 'user',
        content: '第二轮追加问题 2',
        createdAt: '2026-09-29T06:01:02.000Z',
      },
      {
        id: 'a2',
        role: 'assistant',
        content: '第二轮回复内容',
        createdAt: '2026-09-29T06:01:10.000Z',
      },
    ];

    const { container } = render(
      <MessageList
        messages={messages}
        isStreaming={false}
        agents={[]}
        currentAgent={null}
      />,
    );

    const turnElements = container.querySelectorAll<HTMLElement>('.conversation-turn');
    expect(turnElements).toHaveLength(2);

    expect(turnElements[0].getAttribute('data-conversation-turn')).toBe('turn-u1');
    expect(turnElements[1].getAttribute('data-conversation-turn')).toBe('turn-u2');

    const stickyHeaders = container.querySelectorAll<HTMLElement>('.sticky.top-0');
    expect(stickyHeaders).toHaveLength(2);

    // 第 1 轮内只有 1 个独立 user message
    const userMsg1 = turnElements[0].querySelector('[data-message-id="u1"]');
    expect(userMsg1).not.toBeNull();
    expect(turnElements[0].textContent).toContain('第一轮问题');
    expect(turnElements[0].textContent).toContain('第一轮回复内容');

    // 第 2 轮内是 2 个 user message 构成的 user-group
    const userGroup2 = turnElements[1].querySelector('[data-message-role="user-group"]');
    expect(userGroup2).not.toBeNull();
    expect(turnElements[1].textContent).toContain('第二轮问题 1');
    expect(turnElements[1].textContent).toContain('第二轮追加问题 2');
    expect(turnElements[1].textContent).toContain('第二轮回复内容');
  });

  it('没有用户消息时（如系统提示/开局助理消息），依然正常渲染', () => {
    const messages: ChatMessage[] = [
      {
        id: 'a0',
        role: 'assistant',
        content: '你好，我是智能助手。',
        createdAt: '2026-09-29T05:59:00.000Z',
      },
    ];

    const { container } = render(
      <MessageList
        messages={messages}
        isStreaming={false}
        agents={[]}
        currentAgent={null}
      />,
    );

    const turnElements = container.querySelectorAll<HTMLElement>('.conversation-turn');
    expect(turnElements).toHaveLength(1);
    expect(turnElements[0].getAttribute('data-conversation-turn')).toBe('turn-head-a0');
    expect(turnElements[0].querySelector('.sticky.top-0')).toBeNull();
    expect(turnElements[0].textContent).toContain('你好，我是智能助手。');
  });

  it('隐藏内部 goal/loop 唤醒，只显示正常的助手回复', () => {
    const messages: ChatMessage[] = [
      {
        id: 'u-goal',
        role: 'user',
        content: '<objective>do not show</objective>',
        createdAt: '2026-09-29T06:00:00.000Z',
        messageMetadata: JSON.stringify({
          internal: true,
          trigger: 'goal',
          sourceId: 'goal-1',
        }),
      },
      {
        id: 'a-goal',
        role: 'assistant',
        content: '继续执行',
        createdAt: '2026-09-29T06:00:01.000Z',
      },
    ];
    const { queryByTestId, queryByText } = render(
      <MessageList
        messages={messages}
        isStreaming={false}
        agents={[]}
        currentAgent={null}
      />,
    );
    expect(queryByTestId('internal-turn-goal')).toBeNull();
    expect(queryByText(/do not show/)).toBeNull();
    expect(queryByText('继续执行')).not.toBeNull();
  });

  it('停在底部时把最近一份可预览产物交给右侧', () => {
    resetConversationPreviewForTests();
    const messages: ChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: '做一份介绍',
        createdAt: '2026-09-29T06:00:00.000Z',
      },
      {
        id: 'a1',
        role: 'assistant',
        content: '好了',
        createdAt: '2026-09-29T06:00:05.000Z',
      },
    ];
    render(
      <MessageList
        chatId="chat-1"
        messages={messages}
        isStreaming={false}
        agents={[]}
        currentAgent={null}
        turnFilesByMessageId={{
          a1: [
            { path: '/work/build.py', kind: 'created' },
            { path: '/work/deck.pptx', kind: 'created', category: 'deliverable' },
          ],
        }}
      />,
    );
    expect(peekConversationPreview('chat-1')).toEqual({
      chatId: 'chat-1',
      messageId: 'a1',
      path: '/work/deck.pptx',
    });
    resetConversationPreviewForTests();
  });
});

// 「继续」只属于最后一个回合：继续一个更早的失败回合，会在用户后来发的
// 消息之后接上旧任务的输出，前后顺序就乱了。这条对应需求 R2 第 4 条。
describe('MessageList 继续按钮的作用范围（T-CNT-17）', () => {
  const failedAssistant = (id: string, at: string): ChatMessage => ({
    id,
    role: 'assistant',
    content: '',
    createdAt: at,
    messageMetadata: JSON.stringify({
      completionStatus: 'failed',
      completionReason: 'transport error: ConnectError',
    }),
  } as ChatMessage);

  it('只有最后一个回合的失败卡片带「继续」', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: '第一个任务', createdAt: '2026-11-05T06:00:00.000Z' },
      failedAssistant('a1', '2026-11-05T06:00:05.000Z'),
      { id: 'u2', role: 'user', content: '换个事情', createdAt: '2026-11-05T06:01:00.000Z' },
      failedAssistant('a2', '2026-11-05T06:01:05.000Z'),
    ];

    const { container } = render(
      <MessageList
        messages={messages}
        isStreaming={false}
        agents={[]}
        currentAgent={null}
        failureAction={() => ({ onClick: () => {} })}
      />,
    );

    // 两张失败卡片都在，但只有最后一张提供了「继续」。
    expect(container.querySelectorAll('[data-testid="turn-failure"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-action="retry"]')).toHaveLength(1);
  });

  it('用户发了新消息之后，旧失败回合不再有「继续」，重新生成仍在', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: '第一个任务', createdAt: '2026-11-05T06:00:00.000Z' },
      failedAssistant('a1', '2026-11-05T06:00:05.000Z'),
      { id: 'u2', role: 'user', content: '换个事情', createdAt: '2026-11-05T06:01:00.000Z' },
    ];

    const { container } = render(
      <MessageList
        messages={messages}
        isStreaming={false}
        agents={[]}
        currentAgent={null}
        failureAction={() => ({ onClick: () => {} })}
        onRegenerate={async () => {}}
      />,
    );

    expect(container.querySelectorAll('[data-action="retry"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-action="regenerate"]')).toHaveLength(1);
    // 详情入口保留：诊断信息是排查时唯一能拿到的现场。
    expect(container.querySelectorAll('[data-action="details"]')).toHaveLength(1);
  });
});
