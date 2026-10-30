import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalPromptRequest } from '@/lib/host-bridge';
import { ApprovalPromptProvider } from './ApprovalPromptProvider';
import { ChatInput } from './ChatInput';
import { ToolsFlow } from './ExecutedActionsCard';

afterEach(() => {
  cleanup();
  delete (window as { steerableHost?: unknown }).steerableHost;
});

const NAVIGATE: ApprovalPromptRequest = {
  requestId: 'approval-navigate',
  chatId: 'chat-1',
  toolName: 'browser_navigate',
  arguments: { url: 'https://www.example.com/about' },
  mode: 'external',
  category: 'browser',
  categoryLabel: 'Browser actions',
  round: 1,
};

function installBridge() {
  const listeners = new Set<(request: ApprovalPromptRequest) => void>();
  const decide = vi.fn().mockResolvedValue(undefined);
  (window as { steerableHost?: unknown }).steerableHost = {
    approval: {
      onRequest: (callback: (request: ApprovalPromptRequest) => void) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      decide,
      pending: vi.fn().mockResolvedValue([]),
    },
  };
  return {
    decide,
    emit: (request: ApprovalPromptRequest) => {
      for (const callback of listeners) callback(request);
    },
  };
}

describe('browser approval on the web', () => {
  it('asks once for opening a page, not for scrolling or a later action in the same category', () => {
    const bridge = installBridge();
    const { rerender } = render(
      <>
        <ToolsFlow
          actions={[
            {
              tool: 'browser_scroll',
              arguments: { deltaY: 600 },
              result: { success: true },
            },
          ]}
        />
        <ApprovalPromptProvider>
          <ChatInput chatId="chat-1" value="" onChange={vi.fn()} onSubmit={vi.fn()} />
        </ApprovalPromptProvider>
      </>,
    );

    expect(screen.getByText('browser_scroll')).toBeTruthy();
    expect(screen.queryByText('Allowed for this chat')).toBeNull();
    expect(screen.queryByTestId('approval-composer')).toBeNull();
    expect(screen.getByTestId('chat-composer')).toBeTruthy();

    act(() => bridge.emit(NAVIGATE));

    expect(screen.getByTestId('approval-composer')).toBeTruthy();
    expect(screen.getByText('Always allow Browser actions')).toBeTruthy();
    expect(screen.getByText(/Scrolling, reading, and screenshots do not need approval/)).toBeTruthy();

    fireEvent.click(screen.getByText('Allow Browser actions for this chat'));
    expect(bridge.decide).toHaveBeenCalledWith({
      requestId: 'approval-navigate',
      kind: 'allow_for_session',
    });
    expect(screen.queryByTestId('approval-composer')).toBeNull();

    rerender(
      <>
        <ToolsFlow
          actions={[
            {
              tool: 'browser_scroll',
              arguments: { deltaY: 600 },
              result: { success: true },
            },
            {
              tool: 'browser_click',
              arguments: { ref: 'e1' },
              result: { success: true },
              approval: { kind: 'allow_for_session', category: 'browser', cached: true },
            },
          ]}
        />
        <ApprovalPromptProvider>
          <ChatInput chatId="chat-1" value="" onChange={vi.fn()} onSubmit={vi.fn()} />
        </ApprovalPromptProvider>
      </>,
    );

    expect(screen.getByText('browser_click')).toBeTruthy();
    expect(screen.getByText('Allowed for this chat')).toBeTruthy();
    expect(screen.queryByTestId('approval-composer')).toBeNull();
    expect(screen.getByTestId('chat-composer')).toBeTruthy();
  });
});
