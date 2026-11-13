import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  request: vi.fn(),
  saveTextFile: vi.fn(),
}));

vi.mock('@/lib/host-bridge', () => ({
  getHostBridge: () => ({
    localBackend: { request: bridge.request },
    local: { saveTextFile: bridge.saveTextFile },
  }),
}));

vi.mock('@/lib/host-tools', () => ({
  settingsChrome: () => true,
  hostToolChrome: () => true,
}));

vi.mock('@/brand', () => ({
  BRAND_NAME: 'Shell',
}));

const { PortableSettingsPanel } = await import('./PortableSettingsPanel');

afterEach(() => {
  cleanup();
  bridge.request.mockReset();
  bridge.saveTextFile.mockReset();
});

describe('PortableSettingsPanel', () => {
  it('导出配置默认不请求钥匙', async () => {
    bridge.request.mockResolvedValue({
      kind: 'steerable-config',
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      includeSecrets: false,
      sections: {
        llm: { provider: 'openai-compat', model: 'deepseek-chat', apiKeyIncluded: false },
      },
    });
    bridge.saveTextFile.mockResolvedValue({ canceled: false, filePath: '/tmp/shell-配置.json' });

    render(<PortableSettingsPanel />);
    fireEvent.click(screen.getByTestId('portable-export-config'));
    expect((screen.getByTestId('portable-include-secrets') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByTestId('portable-export-confirm'));

    await waitFor(() => {
      expect(bridge.request).toHaveBeenCalledWith({
        method: 'GET',
        path: '/api/v2/portable/config?includeSecrets=0',
      });
    });
    const saved = bridge.saveTextFile.mock.calls[0]?.[0] as { content: string };
    expect(saved.content).not.toContain('sk-');
    expect(saved.content).toContain('deepseek-chat');
    expect(await screen.findByTestId('portable-status')).toBeTruthy();
  });

  it('导出勾选的对话，不出现侧栏那颗按钮依赖的单条文件名', async () => {
    bridge.request.mockImplementation(async (input: { path: string }) => {
      if (input.path.startsWith('/api/v2/chats?')) {
        return {
          chats: [
            { id: 'c1', title: '周报' },
            { id: 'c2', title: '纪要' },
          ],
          pagination: { page: 1, limit: 100, total: 2, totalPages: 1, hasMore: false },
        };
      }
      if (input.path === '/api/v2/chats/c1/portable') {
        return {
          kind: 'steerable-chat',
          schemaVersion: 1,
          chat: { title: '周报' },
          messages: [{ role: 'user', content: '本周' }],
        };
      }
      throw new Error(input.path);
    });
    bridge.saveTextFile.mockResolvedValue({ canceled: false, filePath: '/tmp/shell-对话.json' });

    render(<PortableSettingsPanel />);
    fireEvent.click(screen.getByTestId('portable-export-chats'));
    expect(await screen.findByTestId('portable-chat-c1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('portable-chat-c2'));
    fireEvent.click(screen.getByTestId('portable-export-chats-confirm'));

    await waitFor(() => expect(bridge.saveTextFile).toHaveBeenCalled());
    const saved = bridge.saveTextFile.mock.calls[0]?.[0] as { content: string; defaultPath: string };
    expect(saved.defaultPath).toContain('Chats');
    const body = JSON.parse(saved.content) as { kind: string; chats: Array<{ chat: { title: string } }> };
    expect(body.kind).toBe('steerable-chats');
    expect(body.chats.map((item) => item.chat.title)).toEqual(['周报']);
  });

  it('导入对话只接受对话包，配置包改走导入配置', async () => {
    bridge.request.mockResolvedValue({
      kind: 'steerable-config',
      includeSecrets: false,
      sections: [],
    });
    const picker = stubJsonPicker(JSON.stringify({ kind: 'steerable-config' }));

    render(<PortableSettingsPanel />);
    fireEvent.click(screen.getByTestId('portable-import-chats'));

    expect((await screen.findByTestId('portable-error')).textContent).toContain('This is a config package. Use "Import config".');
    expect(screen.queryByTestId('portable-import-chat-form')).toBeNull();
    picker.mockRestore();
  });

  it('导入对话选出对话包后确认导入', async () => {
    bridge.request.mockImplementation(async (input: { method: string; path: string }) => {
      if (input.method === 'POST' && input.path === '/api/v2/portable/preview') {
        return {
          kind: 'steerable-chat',
          includeSecrets: false,
          sections: [],
          chat: {
            title: '周报',
            messageCount: 2,
            attachmentCount: 0,
            omittedAttachmentCount: 0,
            truncated: false,
          },
        };
      }
      if (input.method === 'POST' && input.path === '/api/v2/portable/chats') {
        return { chatId: 'new', title: '周报', messageCount: 2, attachmentsSaved: 0 };
      }
      throw new Error(`${input.method} ${input.path}`);
    });
    const picker = stubJsonPicker(JSON.stringify({ kind: 'steerable-chat' }));

    render(<PortableSettingsPanel />);
    fireEvent.click(screen.getByTestId('portable-import-chats'));
    expect((await screen.findByTestId('portable-import-chat-form')).textContent).toContain('周报');
    fireEvent.click(screen.getByTestId('portable-import-chat-confirm'));

    expect((await screen.findByTestId('portable-status')).textContent).toContain('Imported chat "周报"');
    picker.mockRestore();
  });
});

function stubJsonPicker(text: string) {
  const original = document.createElement.bind(document);
  return vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: ElementCreationOptions) => {
    const el = original(tag, options);
    if (tag === 'input') {
      const input = el as HTMLInputElement;
      input.click = () => {
        const file = new File([text], 'pack.json', { type: 'application/json' });
        Object.defineProperty(input, 'files', { configurable: true, value: [file] });
        input.dispatchEvent(new Event('change'));
      };
    }
    return el;
  });
}
