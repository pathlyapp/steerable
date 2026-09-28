import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SHOW_THINKING_CONTENT_STORAGE_KEY } from '@/lib/show-thinking-content';
import { I18nProvider } from '@/i18n';
import { configureI18n, registerLocale, resetI18nForTests } from '@/i18n/runtime';
import { AppearanceSettingsPanel } from './AppearanceSettingsPanel';

afterEach(() => {
  cleanup();
  localStorage.removeItem(SHOW_THINKING_CONTENT_STORAGE_KEY);
  localStorage.removeItem('agent-shell.locale');
  resetI18nForTests();
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
    render(
      <I18nProvider>
        <AppearanceSettingsPanel />
      </I18nProvider>,
    );
    expect(screen.getByTestId('locale-settings').textContent).toContain('Language');
    fireEvent.click(screen.getByTestId('locale-option-zh'));
    expect(screen.getByTestId('locale-settings').textContent).toContain('语言');
    expect(screen.getByTestId('thinking-display-hidden').textContent).toBe('隐藏');
  });
});
