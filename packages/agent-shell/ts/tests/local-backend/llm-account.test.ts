import { afterEach, describe, expect, it } from 'vitest';

import { readLlmAccount, resetLlmAccountCache } from '../../src/local-backend/llm-account';

const DEEPSEEK_BODY = {
  is_available: true,
  balance_infos: [
    {
      currency: 'CNY',
      total_balance: '110.00',
      granted_balance: '10.00',
      topped_up_balance: '100.00',
    },
  ],
};

const MOONSHOT_BODY = {
  code: 0,
  data: {
    available_balance: 49.5,
    voucher_balance: 1.5,
    cash_balance: 48,
  },
  status: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  resetLlmAccountCache();
});

describe('readLlmAccount', () => {
  it('其他供应商不发请求', async () => {
    let called = false;
    const account = await readLlmAccount(
      { vendorId: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' },
      { fetchImpl: async () => { called = true; return jsonResponse({}); } },
    );
    expect(called).toBe(false);
    expect(account.status).toBe('unsupported');
  });

  it('DeepSeek 没有密钥时不发请求', async () => {
    let called = false;
    const account = await readLlmAccount(
      { vendorId: 'deepseek', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '  ' },
      { fetchImpl: async () => { called = true; return jsonResponse({}); } },
    );
    expect(called).toBe(false);
    expect(account).toMatchObject({ status: 'missing_key', provider: 'deepseek', label: 'DeepSeek' });
  });

  it('DeepSeek 只请求官方余额地址，并把赠送和充值分开', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const account = await readLlmAccount(
      { vendorId: 'deepseek', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-secret' },
      {
        fetchImpl: async (input, init) => {
          calls.push({ url: String(input), init: init ?? {} });
          return jsonResponse(DEEPSEEK_BODY);
        },
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.deepseek.com/user/balance');
    expect(calls[0].init.redirect).toBe('manual');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-secret');
    expect(account).toMatchObject({
      status: 'ready',
      provider: 'deepseek',
      label: 'DeepSeek',
      available: true,
      currency: 'CNY',
      total: '110.00',
      granted: '10.00',
      toppedUp: '100.00',
    });
    expect(JSON.stringify(account)).not.toContain('sk-secret');
  });

  it('官方主机即使没写 vendorId 也识别为 DeepSeek', async () => {
    const account = await readLlmAccount(
      { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-secret' },
      { fetchImpl: async () => jsonResponse(DEEPSEEK_BODY) },
    );
    expect(account.provider).toBe('deepseek');
    expect(account.total).toBe('110.00');
  });

  it('有人民币余额时优先展示人民币', async () => {
    const account = await readLlmAccount(
      { vendorId: 'deepseek', apiKey: 'sk-secret' },
      {
        fetchImpl: async () => jsonResponse({
          is_available: false,
          balance_infos: [
            { currency: 'USD', total_balance: '1.00', granted_balance: '0.00', topped_up_balance: '1.00' },
            { currency: 'CNY', total_balance: '20.00', granted_balance: '20.00', topped_up_balance: '0.00' },
          ],
        }),
      },
    );
    expect(account).toMatchObject({ available: false, currency: 'CNY', total: '20.00' });
  });

  it('Kimi 国内站查询现金和代金券', async () => {
    const calls: string[] = [];
    const account = await readLlmAccount(
      { vendorId: 'moonshotai-cn', baseUrl: 'https://gateway.example/v1', apiKey: 'sk-kimi' },
      {
        fetchImpl: async (input) => {
          calls.push(String(input));
          return jsonResponse(MOONSHOT_BODY);
        },
      },
    );
    expect(calls).toEqual(['https://api.moonshot.cn/v1/users/me/balance']);
    expect(account).toMatchObject({
      status: 'ready',
      provider: 'moonshot',
      label: 'Kimi',
      currency: 'CNY',
      total: '49.5',
      granted: '1.5',
      toppedUp: '48',
      available: true,
    });
  });

  it('Kimi 国际站走 api.moonshot.ai', async () => {
    const calls: string[] = [];
    const account = await readLlmAccount(
      { vendorId: 'moonshotai', apiKey: 'sk-kimi' },
      {
        fetchImpl: async (input) => {
          calls.push(String(input));
          return jsonResponse({ data: { available_balance: 0, voucher_balance: 0, cash_balance: 0 } });
        },
      },
    );
    expect(calls).toEqual(['https://api.moonshot.ai/v1/users/me/balance']);
    expect(account).toMatchObject({ currency: 'USD', total: '0', available: false });
  });

  it('非 200 和跳转都不当成余额', async () => {
    const denied = await readLlmAccount(
      { vendorId: 'deepseek', apiKey: 'sk-secret' },
      { fetchImpl: async () => jsonResponse({ error: 'nope' }, 401) },
    );
    expect(denied.status).toBe('failed');
    expect(denied.label).toBe('DeepSeek');

    resetLlmAccountCache();
    const redirected = await readLlmAccount(
      { vendorId: 'deepseek', apiKey: 'sk-secret' },
      { fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }) },
    );
    expect(redirected.status).toBe('failed');
  });

  it('30 秒内重复读取不重复请求，refresh 会再请求', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse(DEEPSEEK_BODY);
    };
    const settings = { vendorId: 'deepseek', apiKey: 'sk-secret' };
    await readLlmAccount(settings, { fetchImpl, now: () => 1_000 });
    await readLlmAccount(settings, { fetchImpl, now: () => 10_000 });
    expect(calls).toBe(1);
    await readLlmAccount(settings, { fetchImpl, now: () => 10_000, refresh: true });
    expect(calls).toBe(2);
    await readLlmAccount(settings, { fetchImpl, now: () => 50_000 });
    expect(calls).toBe(3);
  });
});
