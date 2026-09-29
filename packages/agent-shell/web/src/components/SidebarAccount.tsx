/**
 * 侧栏底部的供应商账户余额。只在当前模型是 DeepSeek 或 Kimi，
 * 且本机已经保存了密钥时出现。数字来自供应商余额接口，不是本地估算。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { LuGauge, LuLoaderCircle, LuRefreshCw } from 'react-icons/lu';
import { t } from '@/i18n';
import { hasHostBridge } from '@/lib/host-bridge';
import { getLlmAccount, LLM_SETTINGS_CHANGED_EVENT, type LlmAccount } from '@/lib/local-api';

const POLL_MS = 60_000;

function formatMoney(amount: string, currency: string | null): string {
  const code = (currency ?? '').toUpperCase();
  if (code === 'CNY') return `¥${amount}`;
  if (code === 'USD') return `$${amount}`;
  return code ? `${code} ${amount}` : amount;
}

function numericMoney(amount: string | null): number | null {
  if (amount === null) return null;
  const value = Number(amount);
  return Number.isFinite(value) ? value : null;
}

function breakdown(account: LlmAccount): string {
  if (account.status !== 'ready') return '';
  const currency = account.currency;
  const total = numericMoney(account.total);
  const granted = numericMoney(account.granted);
  const toppedUp = numericMoney(account.toppedUp);
  const hasGrantedBalance = granted !== null && granted > 0;
  const toppedUpAddsInformation =
    toppedUp !== null && total !== null && Math.abs(toppedUp - total) > 0.000001;
  if (!hasGrantedBalance && !toppedUpAddsInformation) return '';

  const parts: string[] = [];
  if (account.provider === 'deepseek') {
    if (hasGrantedBalance && account.granted) {
      parts.push(t('Granted {amount}', { amount: formatMoney(account.granted, currency) }));
    }
    if (account.toppedUp) {
      parts.push(t('Topped up {amount}', { amount: formatMoney(account.toppedUp, currency) }));
    }
  } else if (account.provider === 'moonshot') {
    if (hasGrantedBalance && account.granted) {
      parts.push(t('Voucher {amount}', { amount: formatMoney(account.granted, currency) }));
    }
    if (account.toppedUp) {
      parts.push(t('Cash {amount}', { amount: formatMoney(account.toppedUp, currency) }));
    }
  }
  return parts.join(' · ');
}

export function SidebarAccount() {
  const [account, setAccount] = useState<LlmAccount | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    if (!hasHostBridge()) return;
    const id = ++requestId.current;
    setRefreshing(true);
    try {
      const next = await getLlmAccount(refresh);
      if (id === requestId.current) setAccount(next);
    } catch {
      // 本机接口暂时不可达时保留上一次成功的余额。
    } finally {
      if (id === requestId.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!hasHostBridge()) return;
    void load(false);
    const timer = window.setInterval(() => void load(false), POLL_MS);
    const onFocus = () => void load(false);
    const onSettings = () => void load(true);
    window.addEventListener('focus', onFocus);
    window.addEventListener(LLM_SETTINGS_CHANGED_EVENT, onSettings);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(LLM_SETTINGS_CHANGED_EVENT, onSettings);
    };
  }, [load]);

  if (!account || (account.status !== 'ready' && account.status !== 'failed')) return null;

  const detail = breakdown(account);
  const availableLabel = account.available === true
    ? t('Available')
    : account.available === false
      ? t('Unavailable')
      : null;

  return (
    <div
      data-testid="sidebar-account"
      className="mb-1.5 px-1 py-1"
      aria-label={t('Account balance')}
    >
      <div className="flex items-center gap-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-agent-foreground">
          <LuGauge className="h-3 w-3 shrink-0 text-agent-muted-foreground" />
          <span className="truncate font-medium">{account.label}</span>
        </div>
        <button
          type="button"
          data-testid="sidebar-account-refresh"
          title={t('Refresh balance')}
          aria-label={t('Refresh balance')}
          disabled={refreshing}
          onClick={() => void load(true)}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-agent-muted-foreground/70 transition-colors hover:bg-agent-foreground/10 hover:text-agent-foreground disabled:opacity-50"
        >
          {refreshing ? (
            <LuLoaderCircle className="h-3 w-3 animate-spin" />
          ) : (
            <LuRefreshCw className="h-3 w-3" />
          )}
        </button>
      </div>
      {account.status === 'ready' && account.total ? (
        <>
          <div className="mt-1.5 flex items-center justify-between gap-1.5 text-xs">
            <span className="shrink-0 text-agent-foreground" title={t('Account balance')}>
              {t('Balance')}
            </span>
            <div className="flex min-w-0 items-center justify-end gap-1">
              <span
                data-testid="sidebar-account-total"
                className="shrink-0 font-medium tabular-nums text-agent-foreground"
              >
                {formatMoney(account.total, account.currency)}
              </span>
              {availableLabel ? (
                <span
                  className={`min-w-0 truncate text-[10px] ${account.available ? 'text-emerald-600' : 'text-amber-600'}`}
                >
                  {availableLabel}
                </span>
              ) : null}
            </div>
          </div>
          {detail ? (
            <p
              className="mt-1 truncate text-[9px] leading-none text-agent-muted-foreground"
              title={detail}
            >
              {detail}
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-1 text-[10px] text-agent-muted-foreground">{t('Balance unavailable')}</p>
      )}
    </div>
  );
}
