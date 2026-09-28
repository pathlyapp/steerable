/**
 * 主进程界面文案。与渲染层同一规则：英文是源句，应用层 registerLocale 注入译文。
 * 本模块不依赖 Electron，菜单在 app ready 时读取。
 */

export const SOURCE_LOCALE = 'en';

export function normalizeLocale(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase().replace(/_/g, '-');
  if (!lower) return null;
  if (lower.startsWith('zh')) return 'zh';
  if (lower.startsWith('en')) return 'en';
  const primary = lower.split('-')[0];
  return primary || null;
}

export function resolveLocale(options: {
  supported: readonly string[];
  defaultLocale: string;
  saved: string | null;
  system: string | null;
}): string {
  const supported = options.supported.filter((locale) => locale.length > 0);
  const list = supported.length > 0 ? supported : [SOURCE_LOCALE];
  const pick = (value: string | null): string | null => {
    if (!value) return null;
    if (list.includes(value)) return value;
    const normalized = normalizeLocale(value);
    if (normalized && list.includes(normalized)) return normalized;
    return null;
  };
  return (
    pick(options.saved) ??
    pick(options.system) ??
    pick(options.defaultLocale) ??
    list[0] ??
    SOURCE_LOCALE
  );
}

function formatMessage(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

const catalogs: Record<string, Record<string, string>> = {};
let locales: string[] = [SOURCE_LOCALE];
let defaultLocale = SOURCE_LOCALE;
let current = SOURCE_LOCALE;

export function registerLocale(locale: string, messages: Record<string, string>): void {
  const normalized = locale.trim();
  if (!normalized || normalized === SOURCE_LOCALE) return;
  catalogs[normalized] = { ...catalogs[normalized], ...messages };
}

export function configureI18n(options: {
  locales: readonly string[];
  defaultLocale: string;
  systemLocale?: string | null;
  savedLocale?: string | null;
}): void {
  const next = [...new Set(options.locales.filter((locale) => locale.length > 0))];
  locales = next.length > 0 ? next : [SOURCE_LOCALE];
  defaultLocale = options.defaultLocale || SOURCE_LOCALE;
  current = resolveLocale({
    supported: locales,
    defaultLocale,
    saved: options.savedLocale ?? null,
    system: options.systemLocale ?? null,
  });
}

export function getLocale(): string {
  return current;
}

export function setLocale(locale: string): boolean {
  if (!locales.includes(locale)) return false;
  current = locale;
  return true;
}

export function t(message: string, params?: Record<string, string | number>): string {
  const table = current === SOURCE_LOCALE ? undefined : catalogs[current];
  const template = table?.[message] ?? message;
  return formatMessage(template, params);
}

export function resetI18nForTests(): void {
  for (const key of Object.keys(catalogs)) delete catalogs[key];
  locales = [SOURCE_LOCALE];
  defaultLocale = SOURCE_LOCALE;
  current = SOURCE_LOCALE;
}
