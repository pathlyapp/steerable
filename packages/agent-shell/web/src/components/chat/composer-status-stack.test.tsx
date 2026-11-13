import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ComposerStatusStack } from './composer-status-stack';
import { SessionOrchestrationFlow } from './SessionOrchestrationFlow';
import type { OrchestrationFlowData } from './orchestration-flow-model';
import { SessionTodoList } from './SessionTodoList';
import type { SessionTodo } from './todo-list-model';

afterEach(cleanup);

const DONE_FLOW: OrchestrationFlowData = {
  nodes: [
    {
      childId: '0.1',
      task: '心算 17+28',
      status: 'completed',
      answer: '45',
      steers: [],
    },
  ],
  totalCount: 1,
  completedCount: 1,
  runningCount: 0,
  failedCount: 0,
  interruptedCount: 0,
  closedCount: 0,
  isAllCompleted: true,
  hasActive: false,
  summaryCopy: '1/1 全部完成',
};

const ACTIVE_FLOW: OrchestrationFlowData = {
  ...DONE_FLOW,
  nodes: [
    {
      childId: '0.1',
      task: '心算 17+28',
      status: 'running',
      steers: [],
    },
  ],
  completedCount: 0,
  runningCount: 1,
  isAllCompleted: false,
  hasActive: true,
  summaryCopy: '0/1 执行中',
};

const DONE_TODOS: SessionTodo[] = [
  { id: 'a', content: '调研仓库', status: 'completed' },
  { id: 'b', content: '写补丁', status: 'completed' },
];

const ACTIVE_TODOS: SessionTodo[] = [
  { id: 'a', content: '调研仓库', status: 'completed' },
  { id: 'b', content: '写补丁', status: 'in_progress' },
];

function renderStack(flow: OrchestrationFlowData, todos: SessionTodo[]) {
  return render(
    <ComposerStatusStack>
      <SessionOrchestrationFlow flow={flow} />
      <SessionTodoList todos={todos} />
    </ComposerStatusStack>,
  );
}

describe('ComposerStatusStack', () => {
  it('stacks the two pills vertically', () => {
    renderStack(DONE_FLOW, DONE_TODOS);
    expect(screen.getByTestId('composer-status-stack').className).toContain('flex-col');
  });

  it('keeps expanded panels exclusive', () => {
    renderStack(DONE_FLOW, DONE_TODOS);
    const flowButton = screen.getByRole('button', { name: /Orchestration ready/ });
    const todoButton = screen.getByRole('button', { name: /Task list/ });

    fireEvent.click(flowButton);
    expect(flowButton.getAttribute('aria-expanded')).toBe('true');
    expect(todoButton.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('Multi-agent flow')).toBeTruthy();
    expect(screen.queryByTestId('todo-item-a')).toBeNull();

    fireEvent.click(todoButton);
    expect(todoButton.getAttribute('aria-expanded')).toBe('true');
    expect(flowButton.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('todo-item-a')).toBeTruthy();
    expect(screen.queryByText('Multi-agent flow')).toBeNull();
  });

  it('auto-opens only the orchestration panel when both are active', () => {
    renderStack(ACTIVE_FLOW, ACTIVE_TODOS);
    expect(
      screen.getByRole('button', { name: /心算 17\+28/ }).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: /写补丁/ }).getAttribute('aria-expanded'),
    ).toBe('false');
    expect(screen.queryByTestId('todo-item-b')).toBeNull();
  });
});
