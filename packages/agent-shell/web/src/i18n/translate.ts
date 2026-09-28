/**
 * 界面文案查找。源语言是英语：调用处写英文句子，应用层语言包把英文映射到译文。
 * 缺译文时原样返回英文，漏翻在界面上看得见。
 */

export const SOURCE_LOCALE = 'en';
export const LOCALE_STORAGE_KEY = 'agent-shell.locale';

/** `zh-CN` / `en-US` 收成语言包用的主标签。不认识的标签保留主段。 */
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

export function formatMessage(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** 语言包的键是英文源句。源语言不查表。 */
export function translate(
  message: string,
  locale: string,
  catalogs: Readonly<Record<string, Readonly<Record<string, string>>>>,
  params?: Record<string, string | number>,
): string {
  const table = locale === SOURCE_LOCALE ? undefined : catalogs[locale];
  const template = table?.[message] ?? message;
  return formatMessage(template, params);
}
