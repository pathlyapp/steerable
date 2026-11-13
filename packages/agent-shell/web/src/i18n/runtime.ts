/**
 * 渲染进程的当前语言。产品入口在 bootstrap 前 registerLocale，
 * bootstrap 再 configureI18n。未配置时只有英语。
 */

import {
  LOCALE_STORAGE_KEY,
  SOURCE_LOCALE,
  resolveLocale,
  translate,
} from './translate';

export interface I18nStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface I18nState {
  locales: string[];
  defaultLocale: string;
  locale: string;
  catalogs: Record<string, Record<string, string>>;
}

const state: I18nState = {
  locales: [SOURCE_LOCALE],
  defaultLocale: SOURCE_LOCALE,
  locale: SOURCE_LOCALE,
  catalogs: {},
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeI18n(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function registerLocale(locale: string, messages: Record<string, string>): void {
  const normalized = locale.trim();
  if (!normalized || normalized === SOURCE_LOCALE) return;
  state.catalogs[normalized] = { ...state.catalogs[normalized], ...messages };
  emit();
}

function readStorage(): I18nStorage | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

function systemLocale(): string | null {
  if (typeof navigator === 'undefined') return null;
  return navigator.language || null;
}

export function configureI18n(options: {
  locales: readonly string[];
  defaultLocale: string;
  systemLocale?: string | null;
  storage?: I18nStorage | null;
}): void {
  const locales = [...new Set(options.locales.filter((locale) => locale.length > 0))];
  state.locales = locales.length > 0 ? locales : [SOURCE_LOCALE];
  state.defaultLocale = options.defaultLocale || SOURCE_LOCALE;
  const storage = options.storage === undefined ? readStorage() : options.storage;
  state.locale = resolveLocale({
    supported: state.locales,
    defaultLocale: state.defaultLocale,
    saved: storage?.getItem(LOCALE_STORAGE_KEY) ?? null,
    system: options.systemLocale === undefined ? systemLocale() : options.systemLocale,
  });
  applyDocumentLang(state.locale);
  emit();
}

export function getLocale(): string {
  return state.locale;
}

export function supportedLocales(): readonly string[] {
  return state.locales;
}

export function setLocale(locale: string): boolean {
  if (!state.locales.includes(locale)) return false;
  if (state.locale === locale) return true;
  state.locale = locale;
  const storage = readStorage();
  storage?.setItem(LOCALE_STORAGE_KEY, locale);
  applyDocumentLang(locale);
  emit();
  return true;
}

export function t(message: string, params?: Record<string, string | number>): string {
  return translate(message, state.locale, state.catalogs, params);
}

function applyDocumentLang(locale: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : locale;
}

/** 测试隔离。生产代码不调用。 */
export function resetI18nForTests(): void {
  state.locales = [SOURCE_LOCALE];
  state.defaultLocale = SOURCE_LOCALE;
  state.locale = SOURCE_LOCALE;
  state.catalogs = {};
  listeners.clear();
}
