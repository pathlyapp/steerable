import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SHOW_THINKING_CONTENT_STORAGE_KEY } from '@/lib/show-thinking-content';
import type { ProcessTimelineBlock } from './turn-timeline';
import { TurnProcessTimeline } from './TurnProcessTimeline';

afterEach(() => {
  cleanup();
  localStorage.removeItem(SHOW_THINKING_CONTENT_STORAGE_KEY);
});

interface CustomTool {
  id: string;
  name: string;
}

describe('TurnProcessTimeline', () => {
  it('supports custom tool shapes, hides thinking, and merges adjacent tool groups in Codex style', () => {
    const blocks: Array<ProcessTimelineBlock<CustomTool>> = [
      { type: 'reasoning', content: '先搜一下官方说明' },
      { type: 'text', content: '我先查一下。' },
      { type: 'tools', actions: [{ id: '1', name: 'web_fetch' }] },
      { type: 'reasoning', content: '继续翻网页' },
      {
        type: 'tools',
        actions: [
          { id: '2', name: 'browser_navigate' },
          { id: '3', name: 'browser_read' },
        ],
      },
      { type: 'reasoning', content: '整理结论' },
      { type: 'text', content: '最终缴费流程如下。' },
    ];

    render(
      <TurnProcessTimeline
        blocks={blocks}
        isStreaming={false}
        durationMs={12_000}
        thinkingDisplay="hidden"
        renderTools={(tools) => (
          <div data-testid="custom-tools">{tools.map((t) => t.name).join(',')}</div>
        )}
        renderIntermediateText={(block) => (
          <div data-testid="custom-intermediate">{block.content}</div>
        )}
        renderAnswer={(block) => <div data-testid="custom-answer">{block.content}</div>}
      />,
    );

    const toggle = screen.getByTestId('turn-process-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Worked 12s · 3 tool calls');
    expect(screen.getByTestId('custom-answer').textContent).toBe('最终缴费流程如下。');

    fireEvent.click(toggle);
    expect(screen.queryByTestId('turn-thinking')).toBeNull();
    expect(screen.getByTestId('custom-intermediate').textContent).toBe('我先查一下。');
    expect(screen.getAllByTestId('custom-tools')).toHaveLength(1);
    expect(screen.getByTestId('custom-tools').textContent).toBe(
      'web_fetch,browser_navigate,browser_read',
    );
  });
});
