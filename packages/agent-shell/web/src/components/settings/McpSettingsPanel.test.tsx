import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();

vi.mock('@/lib/electron-bridge', () => ({
  isElectron: () => true,
  getElectronBridge: () => ({
    localBackend: { request },
  }),
}));

const { McpSettingsPanel } = await import('./McpSettingsPanel');

beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async ({ method, path }: { method: string; path: string }) => {
    if (method === 'GET' && path === '/api/v2/mcp/servers') return { servers: [] };
    return {};
  });
});

afterEach(cleanup);

describe('McpSettingsPanel / Streamable HTTP', () => {
  it('submits a remote endpoint with env-referenced authentication', async () => {
    render(<McpSettingsPanel />);
    await waitFor(() => expect(request).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('mcp-add-manual'));
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'streamable-http' },
    });
    fireEvent.change(screen.getByPlaceholderText('名称，如 filesystem'), {
      target: { value: 'remote-docs' },
    });
    fireEvent.change(screen.getByPlaceholderText('https://example.com/mcp'), {
      target: { value: 'https://mcp.example.com/mcp' },
    });
    fireEvent.change(screen.getByPlaceholderText('环境变量请求头（每行 Header=ENV_NAME）'), {
      target: { value: 'X-Api-Key=MCP_API_KEY' },
    });
    fireEvent.change(screen.getByPlaceholderText('Bearer token 环境变量名（可选）'), {
      target: { value: 'MCP_TOKEN' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith({
        method: 'POST',
        path: '/api/v2/mcp/servers',
        body: {
          name: 'remote-docs',
          transport: 'streamable-http',
          url: 'https://mcp.example.com/mcp',
          headers: {},
          headersFromEnv: { 'X-Api-Key': 'MCP_API_KEY' },
          bearerTokenEnvVar: 'MCP_TOKEN',
        },
      });
    });
  });

  it('renders a redacted HTTP entry without needing secret values', async () => {
    request.mockResolvedValueOnce({
      servers: [{
        id: 'remote-1',
        name: 'remote',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        enabled: true,
        serverKey: 'remote',
        toolCount: 2,
        toolsPreview: ['search', 'fetch'],
        lastError: null,
        lastFetchedAt: '2026-09-28T00:00:00Z',
        headerNames: ['X-Tenant'],
        headersFromEnv: { Authorization: 'MCP_TOKEN' },
      }],
    });
    render(<McpSettingsPanel />);
    expect(await screen.findByText('https://mcp.example.com/mcp')).not.toBeNull();
    expect(screen.queryByText(/Bearer secret/)).toBeNull();
  });
});
