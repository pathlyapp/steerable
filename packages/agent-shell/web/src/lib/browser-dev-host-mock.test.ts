import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markDemoMode } from './demo-flag';
import {
  installBrowserDevHostMock,
  resetBrowserDevMockForTests,
} from './browser-dev-host-mock';
import type { LocalBackendStreamEvent } from './host-bridge';

describe('browser-dev-host-mock', () => {
  beforeEach(() => {
    delete (window as { steerableHost?: unknown }).steerableHost;
    markDemoMode();
    resetBrowserDevMockForTests();
    installBrowserDevHostMock();
  });

  afterEach(() => {
    resetBrowserDevMockForTests();
    delete (window as { steerableHost?: unknown }).steerableHost;
  });

  it('implements projects, models, posture, and fixture chat endpoints without errors', async () => {
    const bridge = window.steerableHost!;
    expect(bridge).toBeDefined();

    const projects = await bridge.localBackend.request<{ projects: Array<{ id: string }> }>({
      method: 'GET',
      path: '/api/v2/projects',
    });
    expect(projects.projects.length).toBeGreaterThan(0);

    const models = await bridge.localBackend.request<{
      models: Array<{ id: string }>;
      catalogStatus: string;
    }>({
      method: 'GET',
      path: '/api/v2/llm/models',
    });
    expect(models.catalogStatus).toBe('live');
    expect(models.models.some((m) => m.id === 'glm-5.3-flash')).toBe(true);

    const chats = await bridge.localBackend.request<{ chats: Array<{ id: string }> }>({
      method: 'GET',
      path: '/api/v2/chats?page=1&limit=50',
    });
    expect(chats.chats.length).toBe(4);

    const firstId = chats.chats[0].id;
    const live = await bridge.localBackend.request<{ active: boolean }>({
      method: 'GET',
      path: `/api/v2/chats/${firstId}/live-stream`,
    });
    expect(live.active).toBe(false);

    const dl = await bridge.localBackend.request<{ fileName: string; base64: string }>({
      method: 'GET',
      path: '/api/v2/local/download?chatId=demo-chat-audit&path=%2Fworkspace%2Fsteerable-eval-sandbox%2Faudit-report.md',
    });
    expect(dl.fileName).toBe('audit-report.md');
    expect(dl.base64.length).toBeGreaterThan(10);
  });

  it('streams interactive playbook events and persists assistant message on completion', async () => {
    const bridge = window.steerableHost!;
    const created = await bridge.localBackend.request<{ chatId: string }>({
      method: 'POST',
      path: '/api/v2/chats/new',
      body: {},
    });

    const events: LocalBackendStreamEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      void bridge.localBackend
        .startStream(
          {
            method: 'POST',
            path: `/api/v2/chats/${created.chatId}/run`,
            body: { message: 'Audit this sandbox workspace and generate audit-report.md.' },
          },
          (ev) => {
            events.push(ev);
            if (ev.type === 'end') resolve();
            if (ev.type === 'error') reject(new Error(ev.error));
          },
        )
        .catch(reject);
    });

    const joined = events
      .filter((e): e is { type: 'data'; chunk: string } => e.type === 'data')
      .map((e) => e.chunk)
      .join('');
    expect(joined).toContain('executed_actions');
    expect(joined).toContain('turn_files');
    expect(joined).toContain('turn_usage');
    expect(joined).toContain('[DONE]');

    const history = await bridge.localBackend.request<{
      messages: Array<{ role: string; content: string }>;
    }>({
      method: 'GET',
      path: `/api/v2/chats/${created.chatId}/messages?limit=200`,
    });
    expect(history.messages.some((m) => m.role === 'user')).toBe(true);
    expect(history.messages.some((m) => m.role === 'assistant')).toBe(true);
  });
});
