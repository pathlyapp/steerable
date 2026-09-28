import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { save } = vi.hoisted(() => ({ save: vi.fn(async () => {}) }));

vi.mock('@/lib/host-bridge', () => ({
  hasHostBridge: () => true,
  getHostBridge: () => null,
}));

vi.mock('@/components/settings/LlmSettingsPanel', async () => {
  const react = await import('react');
  return {
    LlmSettingsPanel: react.forwardRef(function MockLlm(
      props: { onSaveUiChange?: (ui: { saving: boolean; savedOk: boolean; loading: boolean }) => void },
      ref,
    ) {
      react.useImperativeHandle(ref, () => ({ save }));
      react.useEffect(() => {
        props.onSaveUiChange?.({ saving: false, savedOk: false, loading: false });
      }, [props.onSaveUiChange]);
      return <div data-testid="llm-panel" />;
    }),
  };
});

vi.mock('@/components/settings/InsightsSettingsPanel', () => ({
  InsightsSettingsPanel: () => null,
}));
vi.mock('@/components/settings/TelemetrySettingsPanel', () => ({
  TelemetrySettingsPanel: () => null,
}));
vi.mock('@/components/settings/UsagePanel', () => ({
  UsagePanel: () => null,
}));
vi.mock('@/components/settings/WebSearchSettingsPanel', () => ({
  WebSearchSettingsPanel: () => null,
}));
vi.mock('@/components/settings/SecuritySettingsPanel', () => ({
  SecuritySettingsPanel: () => null,
}));
vi.mock('@/components/settings/SkillsSettingsPanel', () => ({
  SkillsSettingsPanel: () => null,
}));
vi.mock('@/components/settings/McpSettingsPanel', () => ({
  McpSettingsPanel: () => null,
}));
vi.mock('@/components/settings/AgentsSettingsPanel', () => ({
  AgentsSettingsPanel: () => null,
}));

const { SettingsPage } = await import('./SettingsPage');

function renderSettings(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/settings${search}`]}>
      <SettingsPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  save.mockClear();
});

describe('SettingsPage header save', () => {
  it('saves LLM settings from the general settings header', () => {
    renderSettings();
    fireEvent.click(screen.getByTestId('settings-header-save'));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not show the header save on the plugins page', () => {
    renderSettings('?section=plugins');
    expect(screen.queryByTestId('settings-header-save')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Plugins' })).toBeTruthy();
    expect(screen.getByTestId('plugins-tabs')).toBeTruthy();
    expect(screen.getByTestId('settings-section-agents')).toBeTruthy();
    expect(screen.queryByTestId('settings-section-skills')).toBeNull();
    expect(screen.queryByTestId('settings-section-mcp')).toBeNull();
  });

  it('switches plugin categories and keeps old section links on the matching tab', () => {
    const view = renderSettings('?section=skills');
    expect(screen.queryByTestId('settings-header-save')).toBeNull();
    expect(screen.getByTestId('settings-section-skills')).toBeTruthy();
    expect(screen.getByTestId('plugins-tab-skills').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId('settings-section-agents')).toBeNull();

    fireEvent.click(screen.getByTestId('plugins-tab-mcp'));
    expect(screen.getByTestId('settings-section-mcp')).toBeTruthy();
    expect(screen.queryByTestId('settings-section-skills')).toBeNull();

    fireEvent.click(screen.getByTestId('plugins-tab-web-search'));
    expect(screen.getByTestId('settings-section-web-search')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Web search' })).toBeTruthy();
    expect(screen.queryByTestId('settings-section-mcp')).toBeNull();
    expect(screen.getByTestId('plugins-summary').textContent).toBe(
      'Manage agents, skills, MCP servers, and web search.',
    );
    view.unmount();

    renderSettings('?section=agents');
    expect(screen.getByTestId('settings-section-agents')).toBeTruthy();
    expect(screen.queryByTestId('settings-header-save')).toBeNull();
  });

  it('orders general sections by how often they are used', () => {
    renderSettings();
    expect(screen.getByRole('heading', { name: 'Interface' })).toBeTruthy();
    expect(screen.queryByTestId('settings-section-cli')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Help improve the product' })).toBeTruthy();
    expect(
      [...document.querySelectorAll('[data-testid^="settings-section-"]')].map(
        (el) => el.getAttribute('data-testid'),
      ),
    ).toEqual([
      'settings-section-appearance',
      'settings-section-orchestration',
      'settings-section-llm',
      'settings-section-web-search',
      'settings-section-usage',
      'settings-section-diagnose',
      'settings-section-security',
      'settings-section-insights',
      'settings-section-telemetry',
    ]);
  });

  it('hides side navigation when narrow, shows when wide', () => {
    // 窄屏时不显示侧栏导航
    const { unmount } = renderSettings();
    expect(screen.queryByTestId('settings-side-nav')).toBeNull();
    unmount();

    // Mock ResizeObserver 触发宽屏宽度 (1024px)
    const originalRO = window.ResizeObserver;
    try {
      window.ResizeObserver = class MockRO {
        callback: ResizeObserverCallback;
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }
        observe(target: Element) {
          this.callback(
            [{ target, contentRect: { width: 1024 } as DOMRectReadOnly } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;

      renderSettings();
      expect(screen.getByTestId('settings-side-nav')).toBeTruthy();
      expect(screen.getByText('Settings navigation')).toBeTruthy();
      expect(screen.getByTestId('settings-nav-item-appearance')).toBeTruthy();
      expect(screen.getByTestId('settings-nav-item-orchestration')).toBeTruthy();
      // 右侧未挂载/隐藏的分段（如未支持的 python-runner 或无更新版本的 update），菜单一律不显示
      expect(screen.queryByTestId('settings-nav-item-python-runner')).toBeNull();
      expect(screen.queryByTestId('settings-nav-item-update')).toBeNull();

      // 点击可触发 scrollIntoView
      const scrollIntoViewMock = vi.fn();
      const sectionEl = document.querySelector('[data-testid="settings-section-orchestration"]');
      if (sectionEl) sectionEl.scrollIntoView = scrollIntoViewMock;

      fireEvent.click(screen.getByTestId('settings-nav-item-orchestration'));
      expect(scrollIntoViewMock).toHaveBeenCalled();
    } finally {
      window.ResizeObserver = originalRO;
    }
  });
});
