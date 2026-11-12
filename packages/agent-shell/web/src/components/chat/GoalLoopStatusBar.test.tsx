import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GoalLoopStatusBar } from './GoalLoopStatusBar';

const api = vi.hoisted(() => ({
  updateChatGoal: vi.fn(async () => ({ goal: null })),
  stopChatLoop: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/lib/local-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/local-api')>(),
  updateChatGoal: api.updateChatGoal,
  stopChatLoop: api.stopChatLoop,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GoalLoopStatusBar', () => {
  it('tolerates an older host response without a loops array', () => {
    const { container } = render(
      <GoalLoopStatusBar
        chatId="chat-1"
        goal={null}
        loops={undefined as never}
        onChanged={() => {}}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('hides completed goals', () => {
    const { container } = render(
      <GoalLoopStatusBar
        chatId="chat-1"
        goal={{
          id: 'goal-1',
          chatId: 'chat-1',
          revision: 2,
          objective: 'Ship release',
          phase: 'complete',
          turns: 3,
          createdAt: 1,
          updatedAt: 2,
        }}
        loops={[]}
        onChanged={() => {}}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('shows native goal and monitored loop state and exposes their controls', async () => {
    const changed = vi.fn();
    render(
      <GoalLoopStatusBar
        chatId="chat-1"
        goal={{
          id: 'goal-1',
          chatId: 'chat-1',
          revision: 1,
          objective: 'Ship release',
          phase: 'active',
          turns: 3,
          createdAt: 1,
          updatedAt: 2,
        }}
        loops={[{
          id: 'loop-1',
          chatId: 'chat-1',
          terminalSessionId: 'terminal-1',
          prompt: 'Check CI',
          intervalSeconds: 300,
        }]}
        onChanged={changed}
      />,
    );
    expect(screen.getByText(/Goal · Ship release · Turn 3/)).toBeTruthy();
    expect(screen.getByText(/Loop · Check CI · every 300s/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop loop' }).textContent).toContain('Stop');

    fireEvent.click(screen.getByRole('button', { name: 'Pause goal' }));
    await waitFor(() => expect(api.updateChatGoal).toHaveBeenCalledWith(
      'chat-1',
      { action: 'pause' },
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Stop loop' }));
    await waitFor(() => expect(api.stopChatLoop).toHaveBeenCalledWith('chat-1', 'loop-1'));
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
