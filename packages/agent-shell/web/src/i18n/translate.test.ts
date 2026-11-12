import { describe, expect, it } from 'vitest';

import { formatMessage, normalizeLocale, resolveLocale, translate } from './translate';
import { configureI18n, registerLocale, resetI18nForTests, setLocale, t } from './runtime';

describe('resolveLocale', () => {
  it('prefers a saved locale that the product ships', () => {
    expect(
      resolveLocale({
        supported: ['en', 'zh'],
        defaultLocale: 'zh',
        saved: 'en',
        system: 'zh-CN',
      }),
    ).toBe('en');
  });

  it('follows the system language when nothing is saved', () => {
    expect(
      resolveLocale({
        supported: ['en', 'zh'],
        defaultLocale: 'zh',
        saved: null,
        system: 'en-US',
      }),
    ).toBe('en');
  });

  it('uses the product default when the system language is not shipped', () => {
    expect(
      resolveLocale({
        supported: ['en', 'zh'],
        defaultLocale: 'zh',
        saved: null,
        system: 'ja-JP',
      }),
    ).toBe('zh');
  });

  it('ignores a saved language the product does not ship', () => {
    expect(
      resolveLocale({
        supported: ['zh'],
        defaultLocale: 'zh',
        saved: 'en',
        system: 'en-US',
      }),
    ).toBe('zh');
  });
});

describe('translate', () => {
  it('returns the English source when the locale is en', () => {
    expect(translate('Cancel', 'en', { zh: { Cancel: '取消' } })).toBe('Cancel');
  });

  it('returns the English source when a translation is missing', () => {
    expect(translate('Cancel', 'zh', {})).toBe('Cancel');
  });

  it('fills placeholders from the translated template', () => {
    expect(
      translate('{count} chats', 'zh', { zh: { '{count} chats': '{count} 个会话' } }, { count: 3 }),
    ).toBe('3 个会话');
  });
});

describe('formatMessage', () => {
  it('leaves unknown placeholders in place', () => {
    expect(formatMessage('About {name}', {})).toBe('About {name}');
  });
});

describe('normalizeLocale', () => {
  it('collapses Chinese and English tags', () => {
    expect(normalizeLocale('zh-CN')).toBe('zh');
    expect(normalizeLocale('en_GB')).toBe('en');
    expect(normalizeLocale('')).toBeNull();
  });
});

describe('runtime', () => {
  it('switches locale and reads the registered catalog', () => {
    resetI18nForTests();
    registerLocale('zh', { Cancel: '取消' });
    configureI18n({
      locales: ['en', 'zh'],
      defaultLocale: 'en',
      systemLocale: 'en',
      storage: { getItem: () => null, setItem: () => undefined },
    });
    expect(t('Cancel')).toBe('Cancel');
    expect(setLocale('zh')).toBe(true);
    expect(t('Cancel')).toBe('取消');
    expect(setLocale('ja')).toBe(false);
    resetI18nForTests();
  });
});
