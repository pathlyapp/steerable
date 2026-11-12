import { useEffect, useState } from 'react';
import { LuCircleCheck, LuCircleX, LuLoader, LuPlay } from 'react-icons/lu';
import {
  diagnoseLlmConnection,
  getReliabilitySummary,
  type DiagnoseResult,
  type ReliabilitySummary,
} from '@/lib/local-api';
import { t } from '@/i18n';

/**
 * 设置页「链路诊断」面板：一键探测当前 LLM 配置的连通性
 * （DNS → TCP → TLS → HTTP /models → chat completion），并报告
 * 宿主机的 ambient 代理配置。
 */
/**
 * 「最近 7 天」：失败与重试的统计。
 *
 * 与下面的连接检查分开：检查回答「现在能不能连上」，统计回答「这一周
 * 到底发生了什么」。没有回复时显示空状态，而不是一排 0——0 会被读成
 * 「一切正常」，实际是「还没数据」。
 */
function ReliabilityPanel() {
  const [summary, setSummary] = useState<ReliabilitySummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getReliabilitySummary(7)
      .then((value) => {
        if (!cancelled) setSummary(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <p className="mt-2 text-xs text-agent-muted-foreground" data-testid="reliability-error">
        {t('Could not load the statistics: {error}', { error })}
      </p>
    );
  }
  if (!summary) {
    return (
      <p className="mt-2 text-xs text-agent-muted-foreground" data-testid="reliability-loading">
        {t('Loading…')}
      </p>
    );
  }
  if (summary.total === 0) {
    return (
      <p className="mt-2 text-xs text-agent-muted-foreground" data-testid="reliability-empty">
        {t('No replies in the last 7 days')}
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-2" data-testid="reliability-summary">
      <div className="grid grid-cols-3 gap-2">
        <Stat value={summary.total} label={t('Replies')} />
        <Stat value={summary.failed} label={t('Failed')} />
        <Stat value={summary.recoveredByRetry} label={t('Recovered by retry')} />
      </div>
      {summary.failuresByKind.length > 0 ? (
        <ul className="space-y-1 rounded-agent-sm bg-agent-muted/40 px-2.5 py-1.5 text-xs">
          {summary.failuresByKind.map((row) => (
            <li key={row.kind} className="flex items-center justify-between gap-2">
              <span className="text-agent-muted-foreground">{kindLabel(row.kind)}</span>
              <span className="font-mono text-agent-foreground">{row.count}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {summary.usedDirect > 0 ? (
        <p className="text-xs text-agent-muted-foreground">
          {t('{count} replies went direct instead of through the system proxy.', {
            count: summary.usedDirect,
          })}
        </p>
      ) : null}
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-agent-sm bg-agent-muted/40 px-2.5 py-1.5">
      <div className="font-mono text-sm text-agent-foreground">{value}</div>
      <div className="text-[11px] text-agent-muted-foreground">{label}</div>
    </div>
  );
}

/** Provider failure kinds, in the words a user reads. */
function kindLabel(kind: string): string {
  switch (kind) {
    case 'transport':
      return t('Network');
    case 'auth':
      return t('Credentials');
    case 'rate_limit':
      return t('Rate limit');
    case 'server':
      return t('Service error');
    case 'context_overflow':
      return t('Conversation too long');
    case 'invalid_request':
      return t('Rejected request');
    default:
      return t('Other');
  }
}

export function DiagnoseSettingsPanel() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DiagnoseResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await diagnoseLlmConnection({});
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-2 rounded-agent-md border border-agent-border bg-agent-card p-2.5">
      <p className="text-xs text-agent-muted-foreground">
        {t(
          'Diagnose network connectivity to the current model service, including DNS resolution, TCP connection, TLS handshake, the HTTP endpoint, and chat completion.',
        )}{' '}
        {t('The diagnosis runs in the host process and also reports system and environment proxy settings.')}
      </p>

      <ReliabilityPanel />

      <button
        type="button"
        onClick={() => void run()}
        disabled={running}
        className="inline-flex items-center gap-1.5 rounded-agent-md bg-agent-primary px-3 py-1.5 text-xs font-medium text-agent-primary-foreground transition hover:bg-agent-primary/90 disabled:opacity-50"
      >
        {running ? (
          <>
            <LuLoader className="h-3.5 w-3.5 animate-spin" />
            {t('Diagnosing…')}
          </>
        ) : (
          <>
            <LuPlay className="h-3.5 w-3.5" />
            {t('Start diagnosis')}
          </>
        )}
      </button>

      {error && (
        <p className="rounded-agent-md border border-agent-destructive/20 bg-agent-destructive/10 p-2.5 text-xs text-agent-destructive">
          {t('Diagnosis request failed: {error}', { error })}
        </p>
      )}

      {result && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            {result.ok ? (
              <span className="inline-flex items-center gap-1 text-agent-success">
                <LuCircleCheck className="h-4 w-4" />
                {t('All checks passed')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-agent-destructive">
                <LuCircleX className="h-4 w-4" />
                {t('Diagnosis failed')}
              </span>
            )}
          </div>

          <ol className="space-y-1.5">
            {result.steps.map((step) => (
              <li
                key={step.name}
                className="flex items-start gap-2 rounded-agent-sm bg-agent-muted/50 px-2.5 py-1.5 text-xs"
              >
                {step.ok ? (
                  <LuCircleCheck className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-agent-success" />
                ) : (
                  <LuCircleX className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-agent-destructive" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-agent-foreground">{step.name}</span>
                    <span className="text-agent-muted-foreground">{step.durationMs}ms</span>
                  </div>
                  <p className="mt-0.5 break-all text-agent-muted-foreground">{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>

          {result.ambientProxies.length > 0 && (
            <div className="rounded-agent-sm border border-agent-border bg-agent-muted/30 p-2.5 text-xs">
              <p className="font-medium text-agent-foreground">{t('Detected proxy settings')}</p>
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-agent-muted-foreground">
                {result.ambientProxies.map((proxy) => (
                  <li key={proxy}>{proxy}</li>
                ))}
              </ul>
            </div>
          )}

          {result.hint && (
            <p className="rounded-agent-md border border-agent-warning/20 bg-agent-warning/10 p-2.5 text-xs text-agent-warning">
              {result.hint}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
