/**
 * `<UiSurfaceCard />`
 *
 * Compact in-stream summary card for a declarative `UiSurfacePayload` (wireframe W1).
 * Summarizes steps, row counts, and bound `$source` keys without flooding the chat
 * stream, and opens or focuses `<UiSurfaceWorkbench />` while sharing live draft state.
 */
import * as React from 'react';
import type { UiSurfacePayload } from '@steerable/agent-protocol';
import {
  getUiSurfaceDraft,
  subscribeUiSurfaceDraft,
} from './ui-surface-draft.js';

export interface UiSurfaceCardProps {
  payload: UiSurfacePayload;
  chatId?: string;
  onOpenWorkbench?: (surface: UiSurfacePayload) => void;
  className?: string;
  openWorkbenchLabel?: React.ReactNode;
}

export const UiSurfaceCard: React.FC<UiSurfaceCardProps> = ({
  payload,
  chatId,
  onOpenWorkbench,
  className = '',
  openWorkbenchLabel = 'Open in workbench →',
}) => {
  const [, forceRender] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(
    () => subscribeUiSurfaceDraft(chatId, payload.surfaceId, forceRender),
    [chatId, payload.surfaceId],
  );
  const draft = getUiSurfaceDraft(chatId, payload.surfaceId);

  const stepComponent = payload.components.find((c) => c.kind === 'steps');
  const tableComponent = payload.components.find((c) => c.kind === 'table');
  const resolvedRows = React.useMemo(() => {
    if (!tableComponent) return [];
    if (
      tableComponent.dataKey &&
      payload.resolvedData &&
      Array.isArray(payload.resolvedData[tableComponent.dataKey])
    ) {
      return payload.resolvedData[tableComponent.dataKey] as Record<string, unknown>[];
    }
    return Array.isArray(tableComponent.rows) ? tableComponent.rows : [];
  }, [tableComponent, payload.resolvedData]);

  const sourceNames = React.useMemo(() => {
    const out: string[] = [];
    if (payload.data && typeof payload.data === 'object') {
      for (const val of Object.values(payload.data)) {
        if (val && typeof val === 'object' && typeof (val as { $source?: unknown }).$source === 'string') {
          out.push((val as { $source: string }).$source);
        }
      }
    }
    return out;
  }, [payload.data]);

  return (
    <div
      data-testid="ui-surface-card"
      data-surface-id={payload.surfaceId}
      className={`rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 text-xs dark:border-slate-800 dark:bg-slate-900/50 ${className}`.trim()}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-900 dark:text-slate-100">
            {payload.title}
          </span>
          <span className="rounded bg-slate-200/80 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            v{payload.revision}
          </span>
          {draft.selectedRowIds.length > 0 ? (
            <span
              data-testid="ui-surface-card-draft-count"
              className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300"
            >
              {draft.selectedRowIds.length} selected
            </span>
          ) : null}
        </div>
        {onOpenWorkbench ? (
          <button
            type="button"
            data-testid="ui-surface-open-workbench"
            onClick={() => onOpenWorkbench(payload)}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            {openWorkbenchLabel}
          </button>
        ) : null}
      </div>

      {payload.subtitle ? (
        <p className="mt-1 text-slate-600 dark:text-slate-400">{payload.subtitle}</p>
      ) : null}

      {stepComponent && Array.isArray(stepComponent.steps) && stepComponent.steps.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-700 dark:text-slate-300">
          {stepComponent.steps.map((step, idx) => {
            const mark =
              step.status === 'completed'
                ? '✓'
                : step.status === 'active'
                  ? '●'
                  : step.status === 'failed'
                    ? '✗'
                    : '○';
            return (
              <span key={step.id} className="inline-flex items-center gap-1">
                {idx > 0 ? <span className="text-slate-400">→</span> : null}
                <span>
                  {step.label} {mark}
                </span>
              </span>
            );
          })}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
        {tableComponent ? <span>{resolvedRows.length} rows</span> : null}
        {sourceNames.length > 0 ? (
          <span>Source: {sourceNames.join(', ')}</span>
        ) : null}
      </div>
    </div>
  );
};
