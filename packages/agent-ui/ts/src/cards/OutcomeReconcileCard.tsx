/**
 * `<OutcomeReconcileCard />`
 *
 * Amber stop-and-reconcile card rendered when a non-idempotent (`idempotent: false`)
 * tool call times out, disconnects, or fails after crossing the dispatch boundary
 * (`outcomeUnknown: true`).
 *
 * Neither reconciliation button re-executes the original tool:
 * - `confirmed_not_executed` releases the session lock so a subsequent turn may try again;
 * - `confirmed_succeeded` records external completion in the ledger and keeps duplicate calls blocked.
 */
import * as React from 'react';
import type { OutcomeReconcilePayload } from '@steerable/agent-protocol';

export type OutcomeReconcileDecision =
  | 'confirmed_succeeded'
  | 'confirmed_not_executed';

export interface OutcomeReconcileCardProps {
  payload: OutcomeReconcilePayload;
  isSubmitting?: boolean;
  onReconcile?: (decision: {
    reconciliationId: string;
    resolution: OutcomeReconcileDecision;
    note?: string;
  }) => void;
  className?: string;
  titleLabel?: React.ReactNode;
  descriptionLabel?: React.ReactNode;
  confirmNotExecutedLabel?: React.ReactNode;
  confirmSucceededLabel?: React.ReactNode;
  notePlaceholder?: string;
}

export const OutcomeReconcileCard: React.FC<OutcomeReconcileCardProps> = ({
  payload,
  isSubmitting = false,
  onReconcile,
  className = '',
  titleLabel = 'External execution outcome unknown · automatic retry paused',
  descriptionLabel,
  confirmNotExecutedLabel = 'Confirm not executed, release lock',
  confirmSucceededLabel = 'Confirm executed externally',
  notePlaceholder = 'Optional operator verification note',
}) => {
  const [note, setNote] = React.useState('');
  const isPending = payload.status === 'pending';

  const handleDecision = (resolution: OutcomeReconcileDecision) => {
    if (!isPending || isSubmitting || !onReconcile) return;
    const trimmed = note.trim();
    onReconcile({
      reconciliationId: payload.reconciliationId,
      resolution,
      ...(trimmed ? { note: trimmed } : {}),
    });
  };

  return (
    <div
      data-testid="outcome-reconcile-card"
      data-status={payload.status}
      className={`rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm ${className}`.trim()}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-300">
          <span aria-hidden="true">⚠</span>
          <span>{titleLabel}</span>
        </div>
        <span className="rounded bg-amber-500/20 px-2 py-0.5 font-mono text-xs text-amber-900 dark:text-amber-200">
          {payload.reconciliationId}
        </span>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-amber-900/90 dark:text-amber-100/90">
        {descriptionLabel ?? (
          <>
            Tool <code className="rounded bg-amber-500/20 px-1 py-0.5 font-mono">{payload.toolName}</code>{' '}
            did not return a definitive receipt
            {payload.errorDetail ? ` (${payload.errorDetail})` : ''}. To prevent duplicate side effects,
            further calls to this tool are locked until you verify its external state.
          </>
        )}
      </p>

      {payload.argsPreview ? (
        <pre className="mt-2 max-h-28 overflow-auto rounded-lg border border-amber-500/20 bg-black/5 p-2 font-mono text-xs dark:bg-white/5">
          {payload.argsPreview}
        </pre>
      ) : null}

      {isPending ? (
        <div className="mt-3 space-y-2.5">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={isSubmitting}
            placeholder={notePlaceholder}
            aria-label={notePlaceholder}
            className="w-full rounded-lg border border-amber-500/30 bg-white/80 px-2.5 py-1.5 text-xs outline-none focus:border-amber-600 dark:bg-black/30"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => handleDecision('confirmed_not_executed')}
              data-testid="reconcile-not-executed"
              className="rounded-lg border border-amber-600/40 bg-white/70 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-white disabled:opacity-50 dark:bg-black/30 dark:text-amber-200"
            >
              {confirmNotExecutedLabel}
            </button>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => handleDecision('confirmed_succeeded')}
              data-testid="reconcile-confirmed-succeeded"
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {confirmSucceededLabel}
            </button>
          </div>
        </div>
      ) : (
        <div
          data-testid="reconcile-resolved-summary"
          className="mt-3 rounded-lg border border-amber-500/25 bg-white/50 px-3 py-2 text-xs text-amber-950 dark:bg-black/20 dark:text-amber-100"
        >
          <span className="font-medium">
            {payload.status === 'confirmed_executed'
              ? 'Confirmed executed externally (duplicate calls stay blocked)'
              : 'Confirmed not executed (re-invocation lock released)'}
          </span>
          {payload.resolutionNote ? <span> — {payload.resolutionNote}</span> : null}
        </div>
      )}
    </div>
  );
};
