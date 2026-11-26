import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemorySettingsPanel } from './MemorySettingsPanel';
import { MemorySaveNoticeBar } from '../chat/MemorySaveNoticeBar';

const requestMock = vi.fn();

beforeEach(() => {
  requestMock.mockReset();
  (window as unknown as Record<string, unknown>).steerableHost = {
    localBackend: {
      request: requestMock,
    },
  };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).steerableHost;
});

describe('MemorySettingsPanel & MemorySaveNoticeBar (T-MEM-10)', () => {
  it('renders memory settings, shows 409 baseHash conflict banner, and triggers withdraw action', async () => {
    requestMock.mockImplementation(async ({ method, path }: { method: string; path: string }) => {
      if (method === 'GET' && path.startsWith('/api/v2/memory')) {
        return {
          status: 200,
          data: {
            permissionMode: 'ask',
            scope: 'user',
            scopeId: 'alice',
            contentMarkdown: 'Prefer concise tables.',
            contentSha256: 'hash-v1',
            bytesUsed: 2048,
            maxBytes: 16384,
            linesUsed: 1,
            maxLines: 200,
            refinements: [
              {
                id: 'r_test_1',
                normalizedHash: 'nh1',
                scope: 'user',
                content: 'Always verify schema before import.',
                humanEdited: false,
                status: 'active',
                createdAt: '2026-11-01T00:00:00.000Z',
                expiresAt: '2026-12-01T00:00:00.000Z',
              },
            ],
            revokedHashes: ['rev1'],
          },
        };
      }
      if (method === 'PUT' && path === '/api/v2/memory') {
        return { status: 409, data: { code: 'MEMORY_BASE_HASH_CONFLICT' } };
      }
      return { status: 200, data: {} };
    });

    render(<MemorySettingsPanel showTenantTab={true} isAdmin={true} />);

    await waitFor(() => {
      expect(
        (screen.getByTestId('memory-markdown-editor') as HTMLTextAreaElement).value,
      ).toBe('Prefer concise tables.');
    });
    expect(screen.getByTestId('memory-quota-label').textContent).toContain('2.0 / 16.0 KB');
    expect(screen.getByTestId('memory-refinement-r_test_1')).toBeTruthy();

    fireEvent.click(screen.getByTestId('memory-save-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('memory-conflict-banner')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('memory-withdraw-r_test_1'));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: '/api/v2/memory/refinements/r_test_1/withdraw',
        }),
      );
    });
  });

  it('renders inline MemorySaveNoticeBar and withdraws in one click', async () => {
    requestMock.mockResolvedValue({ status: 200, data: {} });
    const onWithdrawn = vi.fn();

    render(
      <MemorySaveNoticeBar
        refinementId="r_inline_9"
        scope="workspace"
        chatId="c-42"
        onWithdrawn={onWithdrawn}
      />,
    );

    expect(screen.getByTestId('memory-save-notice-bar')).toBeTruthy();
    fireEvent.click(screen.getByTestId('memory-notice-withdraw'));
    await waitFor(() => {
      expect(screen.getByTestId('memory-notice-withdrawn')).toBeTruthy();
    });
    expect(onWithdrawn).toHaveBeenCalledWith('r_inline_9');
  });
});
