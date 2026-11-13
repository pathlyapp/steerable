/**
 * DeepSeek / Kimi 账户余额。
 *
 * 只打这两家的官方余额地址，用已保存的 API Key 做 Bearer。地址是常量，
 * 不采用用户填写的 Base URL，避免密钥被送到任意主机。响应里不带回密钥。
 */

import { createHash } from 'node:crypto';

export interface LlmAccount {
  status: 'ready' | 'unsupported' | 'missing_key' | 'failed';
  provider: 'deepseek' | 'moonshot' | null;
  label: string;
  available: boolean | null;
  currency: string | null;
  total: string | null;
  /** DeepSeek 赠送余额，或 Kimi 代金券余额。 */
  granted: string | null;
  /** DeepSeek 充值余额，或 Kimi 现金余额。 */
  toppedUp: string | null;
}

export interface ReadLlmAccountOptions {
  refresh?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface AccountEndpoint {
  provider: 'deepseek' | 'moonshot';
  label: string;
  url: string;
  /** 余额响应本身不带币种时使用（Kimi）。DeepSeek 以响应里的 currency 为准。 */
  currency: 'CNY' | 'USD' | null;
}

const DEEPSEEK: AccountEndpoint = {
  provider: 'deepseek',
  label: 'DeepSeek',
  url: 'https://api.deepseek.com/user/balance',
  currency: null,
};

const MOONSHOT_CN: AccountEndpoint = {
  provider: 'moonshot',
  label: 'Kimi',
  url: 'https://api.moonshot.cn/v1/users/me/balance',
  currency: 'CNY',
};

const MOONSHOT_AI: AccountEndpoint = {
  provider: 'moonshot',
  label: 'Kimi',
  url: 'https://api.moonshot.ai/v1/users/me/balance',
  currency: 'USD',
};

const READY_TTL_MS = 30_000;
const FAILED_TTL_MS = 15_000;

interface CacheEntry {
  fingerprint: string;
  at: number;
  value: LlmAccount;
}

let cache: CacheEntry | null = null;

export function resetLlmAccountCache(): void {
  cache = null;
}

function empty(status: 'unsupported' | 'missing_key', endpoint: AccountEndpoint | null): LlmAccount {
  return {
    status,
    provider: endpoint?.provider ?? null,
    label: endpoint?.label ?? '',
    available: null,
    currency: null,
    total: null,
    granted: null,
    toppedUp: null,
  };
}

function failed(endpoint: AccountEndpoint): LlmAccount {
  return { ...empty('missing_key', endpoint), status: 'failed' };
}

function hostnameOf(baseUrl: string | undefined): string {
  if (!baseUrl) return '';
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 设置页选中的厂商优先；没选时再看 Base URL 是不是这两家的官方主机。 */
export function accountEndpointFor(settings: {
  vendorId?: string;
  baseUrl?: string;
}): AccountEndpoint | null {
  const vendor = settings.vendorId?.trim().toLowerCase() ?? '';
  if (vendor === 'moonshotai') return MOONSHOT_AI;
  if (vendor === 'moonshotai-cn' || vendor === 'moonshot' || vendor === 'kimi') return MOONSHOT_CN;
  if (vendor === 'deepseek') return DEEPSEEK;
  const host = hostnameOf(settings.baseUrl);
  if (host === 'api.moonshot.ai') return MOONSHOT_AI;
  if (host === 'api.moonshot.cn') return MOONSHOT_CN;
  if (host === 'api.deepseek.com') return DEEPSEEK;
  return null;
}

function moneyString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
    return trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toFixed(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

interface ParsedBalance {
  currency: string;
  total: string;
  granted: string | null;
  toppedUp: string | null;
  available: boolean | null;
}

function pickCurrency(rows: ParsedBalance[]): ParsedBalance {
  const rank = (row: ParsedBalance) => {
    const amount = Number(row.total);
    const positive = Number.isFinite(amount) && amount > 0 ? 2 : 0;
    const currency = row.currency === 'CNY' ? 2 : row.currency === 'USD' ? 1 : 0;
    return positive + currency;
  };
  return [...rows].sort((a, b) => rank(b) - rank(a))[0];
}

function parseDeepseek(body: unknown): ParsedBalance | null {
  const record = asRecord(body);
  if (!record || !Array.isArray(record.balance_infos)) return null;
  const rows: ParsedBalance[] = [];
  for (const item of record.balance_infos) {
    const row = asRecord(item);
    if (!row || typeof row.currency !== 'string') continue;
    const total = moneyString(row.total_balance);
    if (!total) continue;
    rows.push({
      currency: row.currency,
      total,
      granted: moneyString(row.granted_balance),
      toppedUp: moneyString(row.topped_up_balance),
      available: typeof record.is_available === 'boolean' ? record.is_available : null,
    });
  }
  if (rows.length === 0) return null;
  return pickCurrency(rows);
}

function parseMoonshot(body: unknown, currency: string): ParsedBalance | null {
  const record = asRecord(body);
  if (!record) return null;
  const data = asRecord(record.data) ?? record;
  const total = moneyString(data.available_balance);
  if (!total) return null;
  const amount = Number(total);
  return {
    currency,
    total,
    granted: moneyString(data.voucher_balance),
    toppedUp: moneyString(data.cash_balance),
    available: Number.isFinite(amount) ? amount > 0 : null,
  };
}

function fingerprint(endpoint: AccountEndpoint, apiKey: string): string {
  return createHash('sha256').update(`${endpoint.url}\n${apiKey}`).digest('hex');
}

async function fetchBalance(
  endpoint: AccountEndpoint,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<LlmAccount> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint.url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    console.info(
      `[llm] account ${endpoint.provider} unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return failed(endpoint);
  }
  if (response.status !== 200) {
    console.info(`[llm] account ${endpoint.provider} status ${response.status}`);
    return failed(endpoint);
  }
  let body: unknown;
  try {
    const text = await response.text();
    if (text.length > 65_536) return failed(endpoint);
    body = JSON.parse(text) as unknown;
  } catch {
    return failed(endpoint);
  }
  const parsed = endpoint.provider === 'deepseek'
    ? parseDeepseek(body)
    : parseMoonshot(body, endpoint.currency ?? 'CNY');
  if (!parsed) return failed(endpoint);
  return {
    status: 'ready',
    provider: endpoint.provider,
    label: endpoint.label,
    available: parsed.available,
    currency: parsed.currency,
    total: parsed.total,
    granted: parsed.granted,
    toppedUp: parsed.toppedUp,
  };
}

export async function readLlmAccount(
  settings: { vendorId?: string; baseUrl?: string; apiKey?: string },
  options: ReadLlmAccountOptions = {},
): Promise<LlmAccount> {
  const endpoint = accountEndpointFor(settings);
  if (!endpoint) return empty('unsupported', null);
  const apiKey = settings.apiKey?.trim() ?? '';
  if (!apiKey) return empty('missing_key', endpoint);

  const now = options.now ?? Date.now;
  const id = fingerprint(endpoint, apiKey);
  const cached = cache;
  if (!options.refresh && cached && cached.fingerprint === id) {
    const ttl = cached.value.status === 'ready' ? READY_TTL_MS : FAILED_TTL_MS;
    if (now() - cached.at < ttl) return cached.value;
  }

  const account = await fetchBalance(endpoint, apiKey, options.fetchImpl ?? fetch);
  cache = { fingerprint: id, at: now(), value: account };
  return account;
}
