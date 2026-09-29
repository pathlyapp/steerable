import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@steerable/agent-protocol';
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
});
