import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLM_SETTINGS_CHANGED_EVENT, type LlmAccount } from '@/lib/local-api';

let bridgeOn = true;
const getLlmAccount = vi.fn<(refresh?: boolean) => Promise<LlmAccount>>();

vi.mock('@/lib/host-bridge', () => ({
  hasHostBridge: () => bridgeOn,
}));

vi.mock('@/lib/local-api', () => ({
  LLM_SETTINGS_CHANGED_EVENT: 'steerable:llm-settings-changed',
  getLlmAccount: (refresh?: boolean) => getLlmAccount(refresh),
}));

const { SidebarAccount } = await import('./SidebarAccount');

const READY: LlmAccount = {
  status: 'ready',
  provider: 'deepseek',
  label: 'DeepSeek',
  available: true,
  currency: 'CNY',
  total: '110.00',
  granted: '10.00',
  toppedUp: '100.00',
};

beforeEach(() => {
  bridgeOn = true;
  getLlmAccount.mockReset();
  getLlmAccount.mockResolvedValue(READY);
});

afterEach(() => {
  cleanup();
});

describe('SidebarAccount', () => {
  it('没有宿主时不查询余额', () => {
    bridgeOn = false;
    render(<SidebarAccount />);
    expect(getLlmAccount).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sidebar-account')).toBeNull();
  });

  it('DeepSeek 余额显示总额、赠送和充值', async () => {
    render(<SidebarAccount />);
    expect((await screen.findByTestId('sidebar-account-total')).textContent).toBe('¥110.00');
    expect(screen.getByText('DeepSeek')).toBeTruthy();
    expect(screen.getByText('Available')).toBeTruthy();
    expect(screen.getByText('Granted ¥10.00 · Topped up ¥100.00')).toBeTruthy();
    expect(getLlmAccount).toHaveBeenCalledWith(false);
    fireEvent(window, new Event(LLM_SETTINGS_CHANGED_EVENT));
    await waitFor(() => expect(getLlmAccount).toHaveBeenCalledWith(true));
  });

  it('充值余额等于总余额时不重复显示明细', async () => {
    getLlmAccount.mockResolvedValue({
      ...READY,
      total: '280.81',
      granted: '0.00',
      toppedUp: '280.81',
    });
    render(<SidebarAccount />);
    expect((await screen.findByTestId('sidebar-account-total')).textContent).toBe('¥280.81');
    expect(screen.queryByText('Granted ¥0.00 · Topped up ¥280.81')).toBeNull();
  });

  it('Kimi 余额显示代金券和现金', async () => {
    getLlmAccount.mockResolvedValue({
      status: 'ready',
      provider: 'moonshot',
      label: 'Kimi',
      available: true,
      currency: 'CNY',
      total: '49.5',
      granted: '1.5',
      toppedUp: '48',
    });
    render(<SidebarAccount />);
    expect((await screen.findByTestId('sidebar-account-total')).textContent).toBe('¥49.5');
    expect(screen.getByText('Available')).toBeTruthy();
    expect(screen.getByText('Voucher ¥1.5 · Cash ¥48')).toBeTruthy();
  });

  it('查不到余额时保留厂商名并允许重试', async () => {
    getLlmAccount.mockResolvedValue({
      status: 'failed',
      provider: 'deepseek',
      label: 'DeepSeek',
      available: null,
      currency: null,
      total: null,
      granted: null,
      toppedUp: null,
    });
    render(<SidebarAccount />);
    expect(await screen.findByText('Balance unavailable')).toBeTruthy();
    fireEvent.click(screen.getByTestId('sidebar-account-refresh'));
    await waitFor(() => expect(getLlmAccount).toHaveBeenCalledWith(true));
  });

  it('不是 DeepSeek 或 Kimi 时不占侧栏底部', async () => {
    getLlmAccount.mockResolvedValue({
      status: 'unsupported',
      provider: null,
      label: '',
      available: null,
      currency: null,
      total: null,
      granted: null,
      toppedUp: null,
    });
    render(<SidebarAccount />);
    await waitFor(() => expect(getLlmAccount).toHaveBeenCalled());
    expect(screen.queryByTestId('sidebar-account')).toBeNull();
  });
});
