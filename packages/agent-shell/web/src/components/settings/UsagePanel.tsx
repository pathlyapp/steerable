import { useCallback, useEffect, useState } from 'react';
import { LuLoaderCircle, LuChartBar, LuRefreshCw } from 'react-icons/lu';
import { t } from '@/i18n';
import { getHostBridge, hasHostBridge } from '@/lib/host-bridge';

/**
 * UsagePanel — W6-9 用量与成本归因的桌面面板。
 *
 * 每轮 CoreLoop 结束后,local-backend 把该轮的累计 token 用量(以及按
 * framework pricing 单价表估算的 USD 成本)落进 `usage_events` 表;本面板
 * 按 model 分桶聚合展示近 N 天的用量,成本按固定汇率换算为人民币。
 *
 * 成本口径:只统计有单价的模型(framework `MODEL_PRICES`);本地/未知模型
 * 无单价,token 照常计入但成本列渲染为 "—",不计入总成本。
 *
 * 数据自管理:挂载拉一次,可手动刷新 / 切换时间窗。走 local-backend REST
 * (`/api/v2/usage/summary?days=N`),无专用 IPC channel。
 */

interface UsageModelBucketWire {
  model: string;
  provider: string;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  costUsd: number | null;
}

interface UsageSummaryWire {
  sinceDays: number;
  byModel: UsageModelBucketWire[];
  totals: {
    turns: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedPromptTokens: number;
    costUsd: number;
  };
}

const WINDOW_OPTIONS = [{ days: 7 }, { days: 30 }, { days: 90 }] as const;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** 展示用估算汇率。底层仍存 USD,仅在面板换成人民币。 */
const USD_TO_CNY = 7.2;

function formatCost(usd: number | null): string {
  if (usd === null) return '—';
  const cny = usd * USD_TO_CNY;
  if (cny < 0.01) return `¥${cny.toFixed(4)}`;
  return `¥${cny.toFixed(2)}`;
}

export function UsagePanel() {
  const [days, setDays] = useState<number>(30);
  const [summary, setSummary] = useState<UsageSummaryWire | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async (windowDays: number) => {
    if (!hasHostBridge()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getHostBridge()!.localBackend.request<UsageSummaryWire>({
        method: 'GET',
        path: `/api/v2/usage/summary?days=${windowDays}`,
      });
      setSummary(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSummary(days);
  }, [fetchSummary, days]);

  return (
    <div className="space-y-3">
      <div className="bg-agent-muted/30 border border-agent-border/60 rounded-agent-md p-2.5 space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold text-agent-foreground flex items-center gap-1.5">
            <LuChartBar className="h-3.5 w-3.5 text-agent-muted-foreground" />
            {t('Usage and cost')}
          </h4>
          <div className="flex items-center gap-1.5">
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                type="button"
                onClick={() => setDays(opt.days)}
                className={`h-6 px-2 rounded-full text-[10px] font-medium transition-colors ${
                  days === opt.days
                    ? 'bg-agent-foreground text-agent-canvas'
                    : 'bg-agent-canvas text-agent-muted-foreground border border-agent-border hover:bg-agent-muted/40'
                }`}
              >
                {t('Last {days} days', { days: opt.days })}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void fetchSummary(days)}
              disabled={loading}
              className="h-6 w-6 rounded-full border border-agent-border bg-agent-canvas text-agent-muted-foreground hover:bg-agent-muted/40 flex items-center justify-center"
              title={t('Refresh')}
            >
              <LuRefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {loading && !summary ? (
          <div className="flex items-center gap-2 py-4 text-xs text-agent-muted-foreground">
            <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
            {t('Loading usage...')}
          </div>
        ) : !summary || summary.byModel.length === 0 ? (
          <p className="text-[11px] text-agent-muted-foreground py-2">
            {t('No usage in this time window yet. After a conversation turn finishes, tokens and cost are grouped by model here.')}
          </p>
        ) : (
          <>
            {/* 总计卡片 */}
            <div className="grid grid-cols-4 gap-2">
              <div className="rounded-agent-md border border-agent-border bg-agent-canvas px-2.5 py-2">
                <div className="text-[10px] text-agent-muted-foreground">{t('Total turns')}</div>
                <div className="text-xs font-semibold text-agent-foreground">{summary.totals.turns}</div>
              </div>
              <div className="rounded-agent-md border border-agent-border bg-agent-canvas px-2.5 py-2">
                <div className="text-[10px] text-agent-muted-foreground">{t('Total tokens')}</div>
                <div className="text-xs font-semibold text-agent-foreground">{formatTokens(summary.totals.totalTokens)}</div>
              </div>
              <div className="rounded-agent-md border border-agent-border bg-agent-canvas px-2.5 py-2">
                <div className="text-[10px] text-agent-muted-foreground">{t('Cache hits')}</div>
                <div className="text-xs font-semibold text-agent-foreground">{formatTokens(summary.totals.cachedPromptTokens)}</div>
              </div>
              <div className="rounded-agent-md border border-agent-border bg-agent-canvas px-2.5 py-2">
                <div className="text-[10px] text-agent-muted-foreground">{t('Estimated cost')}</div>
                <div className="text-xs font-semibold text-agent-foreground">{formatCost(summary.totals.costUsd)}</div>
              </div>
            </div>

            {/* 按模型分桶 */}
            <div className="rounded-agent-md border border-agent-border overflow-hidden">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="bg-agent-muted/40 text-agent-muted-foreground">
                    <th className="text-left font-medium px-2.5 py-1.5">{t('Model')}</th>
                    <th className="text-right font-medium px-2.5 py-1.5">{t('Turns')}</th>
                    <th className="text-right font-medium px-2.5 py-1.5">{t('Input')}</th>
                    <th className="text-right font-medium px-2.5 py-1.5">{t('Output')}</th>
                    <th className="text-right font-medium px-2.5 py-1.5">{t('Cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byModel.map((b) => (
                    <tr key={`${b.provider}/${b.model}`} className="border-t border-agent-border/50">
                      <td className="px-2.5 py-1.5 font-mono text-agent-foreground truncate max-w-[140px]" title={b.model}>
                        {b.model}
                      </td>
                      <td className="px-2.5 py-1.5 text-right text-agent-muted-foreground">{b.turns}</td>
                      <td className="px-2.5 py-1.5 text-right text-agent-muted-foreground">{formatTokens(b.promptTokens)}</td>
                      <td className="px-2.5 py-1.5 text-right text-agent-muted-foreground">{formatTokens(b.completionTokens)}</td>
                      <td className="px-2.5 py-1.5 text-right text-agent-foreground">{formatCost(b.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-[10px] text-agent-muted-foreground">
              {t(
                'Cost is estimated from the framework price table and converted to RMB at about 1 USD = 7.2 CNY. Only models with a price are counted; "—" means the model has no price (local or unknown). Cache hits are the tokens served from the prompt cache.',
              )}
            </p>
          </>
        )}
      </div>

      {error && (
        <div className="rounded-agent-md border border-agent-destructive/20 bg-agent-destructive/10 p-2.5 text-xs text-agent-destructive">
          {error}
        </div>
      )}
    </div>
  );
}
