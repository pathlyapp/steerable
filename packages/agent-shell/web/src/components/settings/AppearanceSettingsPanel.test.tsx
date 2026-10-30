import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHOW_THINKING_CONTENT_STORAGE_KEY } from '@/lib/show-thinking-content';
import * as hostBridge from '@/lib/host-bridge';
import type { HostBridge } from '@/lib/host-bridge';
import { I18nProvider } from '@/i18n';
import { configureI18n, registerLocale, resetI18nForTests } from '@/i18n/runtime';
import { AppearanceSettingsPanel } from './AppearanceSettingsPanel';

afterEach(() => {
  cleanup();
  localStorage.removeItem(SHOW_THINKING_CONTENT_STORAGE_KEY);
  localStorage.removeItem('agent-shell.locale');
  resetI18nForTests();
  vi.restoreAllMocks();
});

describe('AppearanceSettingsPanel', () => {
  it('defaults to 显示5行', () => {
    render(<AppearanceSettingsPanel />);
    expect(screen.getByTestId('thinking-display-peek').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('thinking-display-hidden').getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(screen.getByTestId('thinking-display-full').getAttribute('aria-checked')).toBe('false');
  });

  it('persists the segmented choice immediately', () => {
    render(<AppearanceSettingsPanel />);
    fireEvent.click(screen.getByTestId('thinking-display-hidden'));
    expect(screen.getByTestId('thinking-display-hidden').getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem(SHOW_THINKING_CONTENT_STORAGE_KEY)).toBe('hidden');
    fireEvent.click(screen.getByTestId('thinking-display-full'));
    expect(screen.getByTestId('thinking-display-full').getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem(SHOW_THINKING_CONTENT_STORAGE_KEY)).toBe('full');
    fireEvent.click(screen.getByTestId('thinking-display-peek'));
    expect(screen.getByTestId('thinking-display-peek').getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem(SHOW_THINKING_CONTENT_STORAGE_KEY)).toBe('peek');
  });

  it('hides the language switch when the product ships one locale', () => {
    configureI18n({
      locales: ['zh'],
      defaultLocale: 'zh',
      systemLocale: 'en-US',
      storage: { getItem: () => null, setItem: () => undefined },
    });
    render(<AppearanceSettingsPanel />);
    expect(screen.queryByTestId('locale-toggle')).toBeNull();
  });

  it('switches chrome between English and Chinese when both are shipped', () => {
    registerLocale('zh', { Language: '语言', Hide: '隐藏' });
    configureI18n({
      locales: ['en', 'zh'],
      defaultLocale: 'en',
      systemLocale: 'en',
      storage: { getItem: () => null, setItem: () => undefined },
    });
    const setHostLocale = vi.fn();
    vi.spyOn(hostBridge, 'getHostBridge').mockReturnValue({
      setLocale: setHostLocale,
    } as HostBridge);
    render(
      <I18nProvider>
        <AppearanceSettingsPanel />
      </I18nProvider>,
    );
    expect(screen.getByTestId('locale-settings').textContent).toContain('Language');
    fireEvent.click(screen.getByTestId('locale-option-zh'));
    expect(screen.getByTestId('locale-settings').textContent).toContain('语言');
    expect(screen.getByTestId('thinking-display-hidden').textContent).toBe('隐藏');
    expect(setHostLocale).toHaveBeenCalledWith('zh');
  });

  it('hides interface zoom when the host has no zoom controls', () => {
    render(<AppearanceSettingsPanel />);
    expect(screen.queryByTestId('interface-zoom')).toBeNull();
  });

  it('steps desktop zoom and disables the ends', async () => {
    const setZoom = vi.fn(async (scale: number) => scale);
    const listeners = new Set<(payload: { scale: number }) => void>();
    vi.spyOn(hostBridge, 'getHostBridge').mockReturnValue({
      getZoom: async () => 1.2,
      setZoom,
      onZoomChanged: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    } as HostBridge);
    render(<AppearanceSettingsPanel />);
    expect((await screen.findByTestId('interface-zoom-level')).textContent).toBe('120%');
    fireEvent.click(screen.getByTestId('interface-zoom-in'));
    fireEvent.click(screen.getByTestId('interface-zoom-in'));
    fireEvent.click(screen.getByTestId('interface-zoom-in'));
    expect(setZoom.mock.calls.map((call) => call[0])).toEqual([1.3, 1.4, 1.5]);
    expect(screen.getByTestId('interface-zoom-level').textContent).toBe('150%');
    fireEvent.click(screen.getByTestId('interface-zoom-reset'));
    expect(setZoom).toHaveBeenLastCalledWith(1);
    expect(screen.getByTestId('interface-zoom-level').textContent).toBe('100%');
    expect(listeners.size).toBe(1);
    act(() => {
      for (const listener of listeners) listener({ scale: 2 });
    });
    expect(screen.getByTestId('interface-zoom-level').textContent).toBe('200%');
    expect(screen.getByTestId('interface-zoom-in')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('interface-zoom-out')).toHaveProperty('disabled', false);
    act(() => {
      for (const listener of listeners) listener({ scale: 0.8 });
    });
    expect(screen.getByTestId('interface-zoom-level').textContent).toBe('80%');
    expect(screen.getByTestId('interface-zoom-out')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('interface-zoom-in')).toHaveProperty('disabled', false);
  });
});
