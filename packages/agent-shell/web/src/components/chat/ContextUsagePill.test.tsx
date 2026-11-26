import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const compactChatMock = vi.fn();
const getChatContextStatusMock = vi.fn();

vi.mock('@/lib/host-bridge', () => ({
  hasHostBridge: () => true,
}));

vi.mock('@/lib/local-api', () => ({
  compactChat: (...args: unknown[]) => compactChatMock(...args),
  getChatContextStatus: (...args: unknown[]) => getChatContextStatusMock(...args),
}));

import { ContextUsagePill } from './ContextUsagePill';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ContextUsagePill (Phase 10 R3 / P2-02)', () => {
  it('renders token and byte usage, prompt cache hit rate, and invokes compactChat with focus', async () => {
    getChatContextStatusMock.mockResolvedValue({
      chatId: 'chat-1',
      recordId: 'chat-1',
      estimatedTokens: 96_000,
      maxContextTokens: 128_000,
      estimatedBytes: 1_572_864,
      maxRequestBytes: 4_194_304,
      promptTokens: 80_000,
      cachedPromptTokens: 60_000,
      cacheCreationTokens: 0,
      compactionCount: 2,
      compactionEpoch: 1,
    });
    compactChatMock.mockResolvedValue({
      compacted: 6,
      preTokens: 96_000,
      postTokens: 18_000,
      compactionEpoch: 2,
    });

    const onCompacted = vi.fn();
    render(
      <ContextUsagePill
        chatId="chat-1"
        messageCount={8}
        isStreaming={false}
        onCompacted={onCompacted}
      />,
    );

    const pill = await screen.findByTestId('context-usage-pill');
    await waitFor(() => expect(pill.textContent).toContain('96k · 75%'));

    fireEvent.click(pill);
    const popover = await screen.findByTestId('context-usage-popover');
    expect(popover.textContent).toContain('75%');
    expect(popover.textContent).toContain('1.5 MB / 4.0 MB');
    expect(popover.textContent).toContain('Auto-compacted 2 times in this chat');

    const focusInput = screen.getByTestId('compact-focus-input');
    fireEvent.change(focusInput, { target: { value: 'keep SQL schema and port 5432' } });
    fireEvent.click(screen.getByTestId('compact-now-btn'));

    await waitFor(() =>
      expect(compactChatMock).toHaveBeenCalledWith('chat-1', {
        focus: 'keep SQL schema and port 5432',
      }),
    );
    await waitFor(() => expect(onCompacted).toHaveBeenCalledOnce());
    expect((await screen.findByTestId('compact-feedback')).textContent).toContain(
      'Compacted 6 earlier messages.',
    );
  });
});
