import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionTodoList } from './SessionTodoList';
import { resolveLatestSessionTodos, type SessionTodo } from './todo-list-model';

afterEach(cleanup);

const TODOS: SessionTodo[] = [
  { id: 'a', content: '调研仓库', status: 'completed' },
  { id: 'b', content: '写补丁', status: 'in_progress' },
  { id: 'c', content: '跑测试', status: 'pending' },
];

describe('SessionTodoList', () => {
  it('执行中（有 in_progress）默认展开，展示步骤列表与 n/m，点击可收起', () => {
    render(<SessionTodoList todos={TODOS} />);
    const header = screen.getByRole('button', { name: /写补丁/ });
    // 执行中默认展开
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('todo-item-c')).toBeTruthy();
    expect(within(header).getByText('写补丁')).toBeTruthy();
    expect(screen.getAllByTestId('todo-progress')[0].textContent).toBe('2/3');
    expect(header.querySelector('svg')).toBeTruthy();

    // 点击后收起
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('todo-item-c')).toBeNull();
  });

  it('展开列表中已完成项带删除线，正在执行项为 in_progress', () => {
    render(<SessionTodoList todos={TODOS} />);
    // 默认展开状态下直接断言
    expect(screen.getByTestId('todo-item-a').getAttribute('data-status')).toBe('completed');
    expect(screen.getByTestId('todo-item-a').querySelector('.line-through')).toBeTruthy();
    expect(screen.getByTestId('todo-item-b').getAttribute('data-status')).toBe('in_progress');
    expect(screen.getAllByTestId('todo-progress')[0].textContent).toBe('2/3');
  });

  it('全部完成时默认折叠收起，展示已完成状态，点击可展开', () => {
    const done = TODOS.map((todo) => ({ ...todo, status: 'completed' as const }));
    render(<SessionTodoList todos={done} />);
    const header = screen.getByRole('button', { name: /Task list/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('todo-progress').textContent).toBe('3/3');
    expect(screen.queryByTestId('todo-item-c')).toBeNull();

    // 点击展开
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('todo-item-c')).toBeTruthy();
  });

  it('T9: tool_start 阶段仅含 arguments 时即实时逐项推进进度 (#24)', () => {
    const step1 = resolveLatestSessionTodos({
      messages: [],
      currentTurnActions: [
        {
          id: 'tc-1',
          tool: 'todo_write',
          mode: 'agent',
          arguments: {
            todos: [
              { id: '1', content: '步骤一', status: 'in_progress' },
              { id: '2', content: '步骤二', status: 'pending' },
              { id: '3', content: '步骤三', status: 'pending' },
              { id: '4', content: '步骤四', status: 'pending' },
            ],
          },
        },
      ],
    })!;
    const { rerender } = render(<SessionTodoList todos={step1} />);
    expect(screen.getAllByTestId('todo-progress')[0].textContent).toBe('1/4');
    expect(screen.getByTestId('todo-item-1').getAttribute('data-status')).toBe('in_progress');

    const step2 = resolveLatestSessionTodos({
      messages: [],
      currentTurnActions: [
        {
          id: 'tc-2',
          tool: 'todo_write',
          mode: 'agent',
          arguments: {
            todos: [
              { id: '1', content: '步骤一', status: 'completed' },
              { id: '2', content: '步骤二', status: 'in_progress' },
              { id: '3', content: '步骤三', status: 'pending' },
              { id: '4', content: '步骤四', status: 'pending' },
            ],
          },
        },
      ],
    })!;
    rerender(<SessionTodoList todos={step2} />);
    expect(screen.getAllByTestId('todo-progress')[0].textContent).toBe('2/4');
    expect(screen.getByTestId('todo-item-1').getAttribute('data-status')).toBe('completed');
    expect(screen.getByTestId('todo-item-2').getAttribute('data-status')).toBe('in_progress');
  });
});
