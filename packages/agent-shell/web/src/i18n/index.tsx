import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  configureI18n,
  getLocale,
  registerLocale,
  setLocale,
  subscribeI18n,
  supportedLocales,
  t,
} from './runtime';

export { configureI18n, getLocale, registerLocale, setLocale, supportedLocales, t };
export { LOCALE_STORAGE_KEY, SOURCE_LOCALE, normalizeLocale, resolveLocale } from './translate';

interface I18nContextValue {
  locale: string;
  locales: readonly string[];
  t: typeof t;
  setLocale: (locale: string) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * 包住应用树。语言变化时用 key 重挂子树，这样直接调用 `t()` 的组件也会换文案。
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setSnapshot] = useState(getLocale);
  useEffect(() => subscribeI18n(() => setSnapshot(getLocale())), []);
  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      locales: supportedLocales(),
      t,
      setLocale: (next) => {
        if (!setLocale(next)) return;
        window.steerableHost?.setLocale?.(next);
      },
    }),
    [locale],
  );
  return (
    <I18nContext.Provider value={value}>
      <div key={locale} className="contents">
        {children}
      </div>
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (value) return value;
  return {
    locale: getLocale(),
    locales: supportedLocales(),
    t,
    setLocale,
  };
}

/** 语言名用该语言自己的写法，不跟着界面语言翻。 */
export function localeEndonym(locale: string): string {
  if (locale === 'zh') return '中文'; // i18n:allow 语言名用该语言自己的写法
  if (locale === 'en') return 'English';
  return locale;
}
