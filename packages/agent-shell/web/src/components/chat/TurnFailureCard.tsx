import { useState } from 'react';
import { LuChevronDown, LuChevronUp, LuCopy, LuTriangleAlert } from 'react-icons/lu';
import { t } from '@/i18n';
import {
  failurePresentation,
  type FailureAction,
  type TurnFailureDetail,
} from './turn-failure';

/**
 * TurnFailureCard — what a failed turn shows in place of an answer.
 *
 * Two layers, chosen by who reads them. The headline and one sentence say
 * what happened and what to do next; nobody needs `SSLEOFError` to press
 * Continue. The details disclosure holds the raw cause, the hop the request
 * took, and the trace id — the material a support reply or a bug report
 * needs, which is exactly why it must not be in the way.
 *
 * The card never decides whether an action is available; it renders the ones
 * its caller passed and shows the rest as disabled. That keeps the choice of
 * "what can this build actually do" in one place (the message list) instead of
 * duplicating capability checks per failure kind.
 */

export interface TurnFailureCardProps {
  /** Classified detail, when the backend recorded one. */
  detail?: TurnFailureDetail;
  /** Raw failure text, always present; the details layer's main content. */
  reason: string;
  /** Tool calls that already completed in this turn. */
  completedSteps?: number;
  /** ISO timestamp of the failed turn, for the details layer. */
  happenedAt?: string;
  /** Trace id, for the details layer and the copied report. */
  traceId?: string;
  /** Renders the action buttons this build can perform. */
  action?: (action: FailureAction) => { onClick: () => void; disabled?: boolean; hint?: string } | null;
}

/** Details-layer field label/value pair. */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-agent-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

export function TurnFailureCard({
  detail,
  reason,
  completedSteps = 0,
  happenedAt,
  traceId,
  action,
}: TurnFailureCardProps) {
  const [open, setOpen] = useState(false);
  const presentation = failurePresentation(detail, { completedSteps });
  const actions = [presentation.primary, ...presentation.secondary]
    .map((entry) => ({ entry, handler: action?.(entry) ?? null }))
    .filter((row): row is { entry: FailureAction; handler: NonNullable<typeof row.handler> } =>
      row.handler !== null,
    );

  return (
    <div
      className="rounded-agent-lg border border-agent-destructive/40 bg-agent-destructive/5 px-2.5 py-2 text-xs leading-relaxed shadow-sm"
      data-testid="turn-failure"
      data-failure-kind={detail?.kind ?? 'unknown'}
    >
      <div className="flex items-start gap-2 font-medium text-agent-destructive">
        <LuTriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        <span>{presentation.title}</span>
      </div>
      <p className="mt-1 ml-5 text-agent-foreground/90">{presentation.body}</p>
      <div className="mt-2 ml-5 flex flex-wrap items-center gap-2">
        {actions.map(({ entry, handler }, index) => (
          <button
            key={entry.kind}
            type="button"
            disabled={handler.disabled}
            title={handler.hint}
            onClick={handler.onClick}
            className={
              index === 0
                ? 'rounded-agent-md bg-agent-primary px-3 py-1 text-xs font-medium text-agent-primary-foreground transition hover:bg-agent-primary/90 disabled:opacity-50'
                : 'rounded-agent-md border border-agent-border bg-agent-card px-3 py-1 text-xs text-agent-foreground transition hover:bg-agent-muted disabled:opacity-50'
            }
            data-action={entry.kind}
          >
            {actionLabel(entry)}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="inline-flex items-center gap-0.5 rounded px-1 text-agent-muted-foreground hover:text-agent-foreground"
          aria-expanded={open}
          data-action="details"
        >
          {open ? t('Hide details') : t('Details')}
          {open ? <LuChevronUp className="h-3 w-3" /> : <LuChevronDown className="h-3 w-3" />}
        </button>
      </div>
      {open && (
        <div className="mt-2 ml-5 border-t border-agent-destructive/20 pt-2" data-testid="turn-failure-details">
          <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1">
            <DetailRow label={t('Category')}>
              {presentation.classified ? categoryLabel(detail?.kind) : t('Not classified')}
            </DetailRow>
            <DetailRow label={t('Cause')}>
              <span className="block">{causeSummary(detail, reason)}</span>
              {presentation.classified && reason !== causeSummary(detail, reason) ? (
                <code className="mt-0.5 block break-all font-mono text-[11px] text-agent-muted-foreground">
                  {reason}
                </code>
              ) : null}
            </DetailRow>
            {detail?.proxy || detail?.kind === 'transport' ? (
              <DetailRow label={t('Connection')}>
                {detail?.proxy
                  ? t('Through system proxy {proxy}', { proxy: detail.proxy })
                  : t('Direct')}
              </DetailRow>
            ) : null}
            {detail?.attempts ? (
              <DetailRow label={t('Retries')}>
                {t('{count} attempts', { count: detail.attempts })}
              </DetailRow>
            ) : null}
            {happenedAt ? (
              <DetailRow label={t('Time')}>
                <span className="font-mono text-[11px]">{happenedAt}</span>
              </DetailRow>
            ) : null}
            {traceId ? (
              <DetailRow label={t('Trace ID')}>
                <span className="font-mono text-[11px]">{traceId}</span>
              </DetailRow>
            ) : null}
          </dl>
          {traceId ? <CopyDiagnostics detail={detail} reason={reason} traceId={traceId} /> : null}
        </div>
      )}
    </div>
  );
}

/** Button text per action, so the card does not repeat the copy three times. */
function actionLabel(action: FailureAction): string {
  switch (action.kind) {
    case 'retry':
      return t('Continue');
    case 'network-diagnostics':
      return t('Network diagnostics');
    case 'open-model-settings':
      return t('Open model settings');
    case 'new-chat':
      return t('New chat');
  }
}

/** The details layer's one-line Chinese cause, or the raw text when unknown. */
function causeSummary(detail: TurnFailureDetail | undefined, reason: string): string {
  switch (detail?.kind) {
    case 'transport':
      return t('The connection to the model service dropped.');
    case 'auth':
      return t('The service rejected the credentials.');
    case 'rate_limit':
      return t('The service asked us to slow down.');
    case 'server':
      return t('The service reported its own failure.');
    case 'context_overflow':
      return t('The request exceeds the model window.');
    case 'invalid_request':
      return t('The service rejected the request.');
    default:
      return reason;
  }
}

function categoryLabel(kind: string | undefined): string {
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
      return t('Not classified');
  }
}

/**
 * One-click report text. Everything a reader needs to reproduce the failure,
 * and nothing that identifies the user: the proxy address is already stripped
 * of credentials by the backend, and the API key never enters a failure.
 */
export function buildDiagnostics(input: {
  detail?: TurnFailureDetail;
  reason: string;
  traceId: string;
  version?: string;
}): string {
  const lines = [
    input.version ? t('Version: {version}', { version: input.version }) : null,
    t('Category: {category}', {
      category: input.detail ? categoryLabel(input.detail.kind) : t('Not classified'),
    }),
    t('Cause: {cause}', { cause: input.reason }),
    input.detail?.proxy
      ? t('Connection: through system proxy {proxy}', { proxy: input.detail.proxy })
      : t('Connection: direct'),
    input.detail?.attempts
      ? t('Retries: {count}', { count: input.detail.attempts })
      : null,
    t('Trace ID: {traceId}', { traceId: input.traceId }),
  ].filter((line): line is string => line !== null);
  return lines.join('\n');
}

function CopyDiagnostics({
  detail,
  reason,
  traceId,
}: {
  detail?: TurnFailureDetail;
  reason: string;
  traceId: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const text = buildDiagnostics({ detail, reason, traceId });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission can be refused (browser, kiosk). The text is
      // already on screen in the details layer, so reporting the failure is
      // only a manual selection away; do not block on it.
      setCopied(false);
    }
  };
  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        type="button"
        onClick={() => void copy()}
        className="inline-flex items-center gap-1 rounded-agent-md border border-agent-border bg-agent-card px-2 py-0.5 text-[11px] hover:bg-agent-muted"
        data-action="copy-diagnostics"
      >
        <LuCopy className="h-3 w-3" />
        {copied ? t('Copied') : t('Copy diagnostic info')}
      </button>
      <span className="text-[11px] text-agent-muted-foreground">
        {t("Doesn't include your API key")}
      </span>
    </div>
  );
}

export default TurnFailureCard;
