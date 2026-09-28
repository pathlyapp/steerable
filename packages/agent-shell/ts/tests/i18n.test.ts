import { describe, expect, it } from 'vitest';

import { configureI18n, registerLocale, resetI18nForTests, setLocale, t } from '../src/i18n.js';

describe('main-process i18n', () => {
  it('keeps English until a product catalog is registered', () => {
    resetI18nForTests();
    configureI18n({ locales: ['en'], defaultLocale: 'en', systemLocale: 'zh-CN' });
    expect(t('File')).toBe('File');
    resetI18nForTests();
  });

  it('uses the Chinese catalog for a zh-only product', () => {
    resetI18nForTests();
    registerLocale('zh', { File: '文件', 'About {name}': '关于 {name}' });
    configureI18n({ locales: ['zh'], defaultLocale: 'zh', systemLocale: 'en-US', savedLocale: 'en' });
    expect(t('File')).toBe('文件');
    expect(t('About {name}', { name: 'Aroli' })).toBe('关于 Aroli');
    expect(setLocale('en')).toBe(false);
    resetI18nForTests();
  });
});
