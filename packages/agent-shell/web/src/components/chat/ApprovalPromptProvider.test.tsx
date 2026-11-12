import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalPromptRequest } from '@/lib/host-bridge';
import { ChatInput } from './ChatInput';
import { ApprovalPromptProvider } from './ApprovalPromptProvider';

afterEach(() => {
  cleanup();
  delete (window as { steerableHost?: unknown }).steerableHost;
});

function installBridge(pendingRequests: ApprovalPromptRequest[] = []) {
  const listeners = new Set<(request: ApprovalPromptRequest) => void>();
  const decide = vi.fn().mockResolvedValue(undefined);
  const pending = vi.fn().mockResolvedValue(pendingRequests);
  (window as { steerableHost?: unknown }).steerableHost = {
    approval: {
      onRequest: (callback: (request: ApprovalPromptRequest) => void) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      decide,
      pending,
    },
  };
  return {
    decide,
    pending,
    emit: (request: ApprovalPromptRequest) => {
      for (const callback of listeners) callback(request);
    },
  };
}

const REQUEST: ApprovalPromptRequest = {
  requestId: 'approval-1',
  toolName: 'local_exec_shell',
  arguments: { command: 'pwd' },
  mode: 'read',
  category: 'local_exec_shell',
  round: 1,
};

function renderComposer() {
  render(
    <ApprovalPromptProvider>
      <ChatInput value="" onChange={vi.fn()} onSubmit={vi.fn()} />
    </ApprovalPromptProvider>,
  );
}

describe('ApprovalPromptProvider', () => {
  it('replaces the composer and restores it after a decision', () => {
    const bridge = installBridge();
    renderComposer();
    expect(screen.getByTestId('chat-composer')).toBeTruthy();

    act(() => bridge.emit(REQUEST));

    expect(screen.queryByTestId('chat-composer')).toBeNull();
    expect(screen.getByTestId('approval-composer')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByText('Allow once'));
    expect(bridge.decide).toHaveBeenCalledWith({
      requestId: 'approval-1',
      kind: 'allow_once',
    });
    expect(screen.getByTestId('chat-composer')).toBeTruthy();
  });

  it('restores an approval request after the renderer remounts', async () => {
    const bridge = installBridge([REQUEST]);
    renderComposer();

    expect(await screen.findByTestId('approval-composer')).toBeTruthy();
    expect(screen.queryByTestId('chat-composer')).toBeNull();
    expect(bridge.pending).toHaveBeenCalledOnce();
  });

  it('binds an unscoped prompt to the open chat and hides it elsewhere', () => {
    window.location.hash = '#/agent/chat-a';
    const bridge = installBridge();
    const { rerender } = render(
      <ApprovalPromptProvider>
        <ChatInput chatId="chat-b" value="" onChange={vi.fn()} onSubmit={vi.fn()} />
      </ApprovalPromptProvider>,
    );
    act(() => bridge.emit(REQUEST));

    expect(screen.queryByTestId('approval-composer')).toBeNull();
    expect(screen.getByTestId('chat-composer')).toBeTruthy();

    rerender(
      <ApprovalPromptProvider>
        <ChatInput chatId="chat-a" value="" onChange={vi.fn()} onSubmit={vi.fn()} />
      </ApprovalPromptProvider>,
    );
    expect(screen.getByTestId('approval-composer')).toBeTruthy();
    window.location.hash = '';
  });

  it('hides a prompt that belongs to another chat', () => {
    const bridge = installBridge();
    const { rerender } = render(
      <ApprovalPromptProvider>
        <ChatInput chatId="chat-b" value="" onChange={vi.fn()} onSubmit={vi.fn()} />
      </ApprovalPromptProvider>,
    );
    act(() => bridge.emit({ ...REQUEST, chatId: 'chat-a' }));

    expect(screen.queryByTestId('approval-composer')).toBeNull();
    expect(screen.getByTestId('chat-composer')).toBeTruthy();

    rerender(
      <ApprovalPromptProvider>
        <ChatInput chatId="chat-a" value="" onChange={vi.fn()} onSubmit={vi.fn()} />
      </ApprovalPromptProvider>,
    );

    expect(screen.getByTestId('approval-composer')).toBeTruthy();
    expect(screen.getByText(/local_exec_shell/)).toBeTruthy();
  });

  it('decides only the prompt belonging to this chat', () => {
    const bridge = installBridge();
    render(
      <ApprovalPromptProvider>
        <ChatInput chatId="chat-a" value="" onChange={vi.fn()} onSubmit={vi.fn()} />
      </ApprovalPromptProvider>,
    );
    act(() => {
      bridge.emit({ ...REQUEST, chatId: 'chat-b', requestId: 'approval-b' });
      bridge.emit({ ...REQUEST, chatId: 'chat-a', requestId: 'approval-a' });
    });

    fireEvent.click(screen.getByText('Allow once'));
    expect(bridge.decide).toHaveBeenCalledWith({
      requestId: 'approval-a',
      kind: 'allow_once',
    });
    expect(screen.getByTestId('chat-composer')).toBeTruthy();
  });
});
