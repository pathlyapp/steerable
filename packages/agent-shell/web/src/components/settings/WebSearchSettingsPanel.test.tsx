import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();

vi.mock('@/lib/host-bridge', () => ({
  hasHostBridge: () => true,
  getHostBridge: () => ({
    localBackend: { request },
  }),
}));

const { WebSearchSettingsPanel } = await import('./WebSearchSettingsPanel');

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue({ provider: 'tavily', apiKey: '' });
});

afterEach(cleanup);

describe('WebSearchSettingsPanel', () => {
  it('loads Tavily by default and hides the key field on the free backend', async () => {
    render(<WebSearchSettingsPanel />);
    await screen.findByTestId('web-search-provider-ddg');
    expect(screen.getByText('Tavily API Key')).toBeTruthy();

    fireEvent.click(screen.getByTestId('web-search-provider-ddg'));
    expect(screen.queryByText('Tavily API Key')).toBeNull();
    expect(screen.getByText(/public DuckDuckGo search page/)).toBeTruthy();
  });

  it('POSTs provider=ddg and shows the restart copy', async () => {
    request
      .mockResolvedValueOnce({ provider: 'tavily' })
      .mockResolvedValueOnce({ provider: 'ddg' });

    render(<WebSearchSettingsPanel />);
    await screen.findByTestId('web-search-provider-ddg');
    fireEvent.click(screen.getByTestId('web-search-provider-ddg'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: '/api/v2/local-settings/web-search',
          body: { provider: 'ddg', apiKey: '' },
        }),
      );
    });
    expect(await screen.findByText(/the sidecar registers free search/)).toBeTruthy();
  });

  it('keeps 免费 selected when the save echo omits provider', async () => {
    request.mockResolvedValueOnce({ provider: 'tavily' }).mockResolvedValueOnce({});

    render(<WebSearchSettingsPanel />);
    await screen.findByTestId('web-search-provider-ddg');
    fireEvent.click(screen.getByTestId('web-search-provider-ddg'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/the sidecar registers free search/)).toBeTruthy();
    expect(screen.queryByText('Tavily API Key')).toBeNull();
    expect(screen.getByTestId('web-search-provider-ddg').className).toContain('border-agent-foreground/40');
  });

  it('POSTs a Tavily key and keeps the key field', async () => {
    request
      .mockResolvedValueOnce({ provider: 'tavily' })
      .mockResolvedValueOnce({ provider: 'tavily', apiKey: 'tvly-k' });

    render(<WebSearchSettingsPanel />);
    const keyInput = await screen.findByPlaceholderText('tvly-... (leave blank = do not register Tavily)');
    fireEvent.change(keyInput, { target: { value: ' tvly-k ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: '/api/v2/local-settings/web-search',
          body: { provider: 'tavily', apiKey: 'tvly-k' },
        }),
      );
    });
    expect(await screen.findByText(/the sidecar registers web_search/)).toBeTruthy();
    expect(screen.getByText('Tavily API Key')).toBeTruthy();
  });
});
