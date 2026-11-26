/**
 * `<UiSurfaceWorkbench />`
 *
 * Declarative structured business workbench (v1) supporting the 6 closed component
 * kinds (`table`, `detail-card`, `form`, `steps`, `kv-diff`, `artifact-card`).
 *
 * Security & data integrity invariants:
 * - Zero `dangerouslySetInnerHTML` or raw HTML rendering; all values render as React text nodes.
 * - Row selection submits ONLY `selectedRowIds` + `expectedRevision` + `sourceHashes` + `commandId`;
 *   authoritative row values stay on the server and are re-verified via `$source` hashes.
 * - When the server responds with `409 UI_STALE`, renders a prominent warning banner (wireframe W3)
 *   and allows refreshing data while preserving non-conflicting draft edits and highlighting changed cells.
 */
import * as React from 'react';
import type { UiSurfacePayload } from '@steerable/agent-protocol';
import {
  getUiSurfaceDraft,
  patchUiSurfaceDraft,
  subscribeUiSurfaceDraft,
} from './ui-surface-draft.js';

export interface UiSurfaceActionDispatchRequest {
  readonly surfaceId: string;
  readonly actionId: string;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly selectedRowIds: readonly string[];
  readonly formValues: Readonly<Record<string, string | number | boolean>>;
  readonly kvDiffOverrides: Readonly<Record<string, string>>;
  readonly note?: string;
}

export interface UiSurfaceWorkbenchProps {
  payload: UiSurfacePayload;
  chatId?: string;
  staleBannerKeys?: readonly string[];
  isBusy?: boolean;
  onDispatchAction?: (req: UiSurfaceActionDispatchRequest) => void | Promise<void>;
  onRefreshSurface?: (surfaceId: string) => void | Promise<void>;
  className?: string;
}

type SurfaceComponent = UiSurfacePayload['components'][number];

function createCommandId(surfaceId: string, actionId: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `cmd_${surfaceId}_${actionId}_${Date.now()}_${rand}`;
}

function resolveTableRows(
  comp: SurfaceComponent,
  resolvedData: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  if (comp.dataKey && resolvedData && Array.isArray(resolvedData[comp.dataKey])) {
    return resolvedData[comp.dataKey] as Record<string, unknown>[];
  }
  return Array.isArray(comp.rows) ? (comp.rows as Record<string, unknown>[]) : [];
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export const UiSurfaceWorkbench: React.FC<UiSurfaceWorkbenchProps> = ({
  payload,
  chatId,
  staleBannerKeys,
  isBusy = false,
  onDispatchAction,
  onRefreshSurface,
  className = '',
}) => {
  const [, forceRender] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(
    () => subscribeUiSurfaceDraft(chatId, payload.surfaceId, forceRender),
    [chatId, payload.surfaceId],
  );
  const draft = getUiSurfaceDraft(chatId, payload.surfaceId);

  // Track previous cell values across revisions so refreshed cells flash yellow for 2s
  const prevRowSnapshotsRef = React.useRef<Map<string, string>>(new Map());
  const [changedCellKeys, setChangedCellKeys] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    const nextSnapshots = new Map<string, string>();
    const newlyChanged = new Set<string>();
    for (const comp of payload.components) {
      if (comp.kind !== 'table') continue;
      const idField = comp.rowIdField || 'id';
      const rows = resolveTableRows(comp, payload.resolvedData);
      for (const row of rows) {
        const rowId = String(row[idField] ?? '');
        if (!rowId) continue;
        for (const [colKey, cellVal] of Object.entries(row)) {
          const snapKey = `${comp.id}::${rowId}::${colKey}`;
          const serialized = formatCellValue(cellVal);
          nextSnapshots.set(snapKey, serialized);
          const prev = prevRowSnapshotsRef.current.get(snapKey);
          if (prev !== undefined && prev !== serialized) {
            newlyChanged.add(snapKey);
          }
        }
      }
    }
    prevRowSnapshotsRef.current = nextSnapshots;
    if (newlyChanged.size > 0) {
      setChangedCellKeys(newlyChanged);
      const timer = setTimeout(() => setChangedCellKeys(new Set()), 2000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [payload.revision, payload.components, payload.resolvedData]);

  const effectiveStaleKeys =
    staleBannerKeys && staleBannerKeys.length > 0
      ? staleBannerKeys
      : payload.staleKeys ?? [];

  const toggleRow = (rowId: string) => {
    const set = new Set(draft.selectedRowIds);
    if (set.has(rowId)) {
      set.delete(rowId);
    } else {
      set.add(rowId);
    }
    patchUiSurfaceDraft(chatId, payload.surfaceId, {
      selectedRowIds: [...set],
    });
  };

  const handleActionClick = (action: NonNullable<UiSurfacePayload['actions']>[number]) => {
    if (isBusy || !onDispatchAction) return;
    if (action.requiresSelection && draft.selectedRowIds.length === 0) return;
    const commandId = createCommandId(payload.surfaceId, action.id);
    const trimmedNote = draft.note.trim();
    void onDispatchAction({
      surfaceId: payload.surfaceId,
      actionId: action.id,
      commandId,
      expectedRevision: payload.revision,
      sourceHashes: payload.sourceHashes ?? {},
      selectedRowIds: draft.selectedRowIds,
      formValues: draft.formValues,
      kvDiffOverrides: draft.kvDiffOverrides,
      ...(trimmedNote ? { note: trimmedNote } : {}),
    });
  };

  return (
    <div
      data-testid="ui-surface-workbench"
      data-surface-id={payload.surfaceId}
      data-revision={payload.revision}
      className={`flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 text-xs dark:border-slate-800 dark:bg-slate-950 ${className}`.trim()}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3 dark:border-slate-800">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {payload.title}
          </h3>
          {payload.subtitle ? (
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {payload.subtitle}
            </p>
          ) : null}
        </div>
        <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600 dark:bg-slate-900 dark:text-slate-300">
          Synced · v{payload.revision}
        </span>
      </div>

      {/* W3: 409 UI_STALE banner */}
      {effectiveStaleKeys.length > 0 ? (
        <div
          role="alert"
          data-testid="ui-surface-stale-banner"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-amber-950 dark:text-amber-200"
        >
          <span>
            ⚠ Underlying business data changed ({effectiveStaleKeys.join(', ')}). This submission
            was safely blocked before any changes were written.
          </span>
          {onRefreshSurface ? (
            <button
              type="button"
              data-testid="ui-surface-refresh-btn"
              disabled={isBusy}
              onClick={() => void onRefreshSurface(payload.surfaceId)}
              className="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              Refresh latest data
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Closed 6-component renderer */}
      <div className="space-y-4">
        {payload.components.map((comp) => {
          switch (comp.kind) {
            case 'steps': {
              const steps = Array.isArray(comp.steps) ? comp.steps : [];
              return (
                <div key={comp.id} data-testid={`surface-steps-${comp.id}`} className="flex flex-wrap items-center gap-3">
                  {steps.map((step, index) => (
                    <div key={step.id} className="flex items-center gap-1.5">
                      {index > 0 ? <span className="text-slate-400">───</span> : null}
                      <span
                        className={`rounded-full px-2 py-0.5 font-medium ${
                          step.status === 'completed'
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                            : step.status === 'active'
                              ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
                              : step.status === 'failed'
                                ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                                : 'bg-slate-100 text-slate-500 dark:bg-slate-900'
                        }`}
                      >
                        {step.label}
                      </span>
                    </div>
                  ))}
                </div>
              );
            }

            case 'table': {
              const rows = resolveTableRows(comp, payload.resolvedData);
              const columns = Array.isArray(comp.columns) ? comp.columns : [];
              const idField = comp.rowIdField || 'id';
              const selectable = comp.selectable !== false;
              return (
                <div key={comp.id} data-testid={`surface-table-${comp.id}`} className="space-y-1.5">
                  {comp.title ? (
                    <div className="flex items-center justify-between font-medium text-slate-800 dark:text-slate-200">
                      <span>{comp.title}</span>
                      {selectable ? (
                        <span className="text-[11px] text-slate-500">
                          Selected {draft.selectedRowIds.length} / {rows.length}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
                    <table className="w-full border-collapse text-left text-xs">
                      <thead className="bg-slate-50 text-slate-600 dark:bg-slate-900 dark:text-slate-400">
                        <tr>
                          {selectable ? <th className="w-8 px-2.5 py-2" aria-label="Select row" /> : null}
                          {columns.map((col) => (
                            <th key={col.key} className="px-2.5 py-2 font-medium">
                              {col.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                        {rows.map((row, idx) => {
                          const rowId = String(row[idField] ?? idx);
                          const checked = draft.selectedRowIds.includes(rowId);
                          return (
                            <tr key={rowId} data-row-id={rowId}>
                              {selectable ? (
                                <td className="px-2.5 py-2">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleRow(rowId)}
                                    data-testid={`surface-row-check-${rowId}`}
                                    aria-label={`Select row ${rowId}`}
                                  />
                                </td>
                              ) : null}
                              {columns.map((col) => {
                                const snapKey = `${comp.id}::${rowId}::${col.key}`;
                                const highlighted = changedCellKeys.has(snapKey);
                                return (
                                  <td
                                    key={col.key}
                                    data-highlighted={highlighted ? 'true' : undefined}
                                    className={`px-2.5 py-2 transition-colors ${
                                      highlighted ? 'bg-amber-200/60 dark:bg-amber-500/30' : ''
                                    }`}
                                  >
                                    {formatCellValue(row[col.key])}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            }

            case 'detail-card': {
              const fields = Array.isArray(comp.fields) ? comp.fields : [];
              return (
                <div
                  key={comp.id}
                  data-testid={`surface-detail-${comp.id}`}
                  className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"
                >
                  {comp.title ? (
                    <div className="mb-2 font-medium text-slate-800 dark:text-slate-200">
                      {comp.title}
                    </div>
                  ) : null}
                  <dl className="grid grid-cols-2 gap-2">
                    {fields.map((field) => (
                      <div key={field.key}>
                        <dt className="text-[11px] text-slate-500">{field.label}</dt>
                        <dd className="font-medium text-slate-900 dark:text-slate-100">
                          {formatCellValue(field.value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              );
            }

            case 'form': {
              const fields = Array.isArray(comp.fields) ? comp.fields : [];
              return (
                <div key={comp.id} data-testid={`surface-form-${comp.id}`} className="space-y-2.5">
                  {comp.title ? (
                    <div className="font-medium text-slate-800 dark:text-slate-200">
                      {comp.title}
                    </div>
                  ) : null}
                  {fields.map((field) => {
                    const val =
                      draft.formValues[field.key] ??
                      (typeof field.value === 'string' ||
                      typeof field.value === 'number' ||
                      typeof field.value === 'boolean'
                        ? field.value
                        : '');
                    return (
                      <label key={field.key} className="block space-y-1">
                        <span className="text-[11px] font-medium text-slate-700 dark:text-slate-300">
                          {field.label}
                        </span>
                        {field.type === 'select' && Array.isArray(field.options) ? (
                          <select
                            value={String(val)}
                            onChange={(e) =>
                              patchUiSurfaceDraft(chatId, payload.surfaceId, {
                                formValues: { [field.key]: e.target.value },
                              })
                            }
                            data-testid={`surface-form-input-${field.key}`}
                            className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                          >
                            {field.options.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type={field.type === 'number' ? 'number' : 'text'}
                            value={String(val)}
                            onChange={(e) =>
                              patchUiSurfaceDraft(chatId, payload.surfaceId, {
                                formValues: {
                                  [field.key]:
                                    field.type === 'number'
                                      ? Number(e.target.value)
                                      : e.target.value,
                                },
                              })
                            }
                            data-testid={`surface-form-input-${field.key}`}
                            className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                          />
                        )}
                      </label>
                    );
                  })}
                </div>
              );
            }

            case 'kv-diff': {
              const diffs = Array.isArray(comp.diffs) ? comp.diffs : [];
              return (
                <div key={comp.id} data-testid={`surface-kvdiff-${comp.id}`} className="space-y-2">
                  {comp.title ? (
                    <div className="font-medium text-slate-800 dark:text-slate-200">
                      {comp.title}
                    </div>
                  ) : null}
                  {diffs.map((item) => {
                    const afterVal =
                      draft.kvDiffOverrides[item.key] ?? formatCellValue(item.after);
                    return (
                      <div
                        key={item.key}
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 p-2 dark:border-slate-800"
                      >
                        <span className="font-mono text-[11px] text-slate-500">
                          {item.label || item.key}:
                        </span>
                        <span className="line-through text-rose-600 dark:text-rose-400">
                          {formatCellValue(item.before)}
                        </span>
                        <span className="text-slate-400">→</span>
                        <input
                          type="text"
                          value={afterVal}
                          onChange={(e) =>
                            patchUiSurfaceDraft(chatId, payload.surfaceId, {
                              kvDiffOverrides: { [item.key]: e.target.value },
                            })
                          }
                          aria-label={`Replacement value for ${item.label || item.key}`}
                          data-testid={`surface-kvdiff-input-${item.key}`}
                          className="min-w-[10rem] flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
                        />
                      </div>
                    );
                  })}
                </div>
              );
            }

            case 'artifact-card': {
              const art = comp.artifact ?? {};
              return (
                <div
                  key={comp.id}
                  data-testid={`surface-artifact-${comp.id}`}
                  className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
                >
                  <div>
                    <div className="font-medium text-slate-900 dark:text-slate-100">
                      {art.name || comp.title || 'Deliverable artifact'}
                    </div>
                    {art.sha256 ? (
                      <div className="font-mono text-[11px] text-slate-500">
                        SHA-256: {art.sha256.slice(0, 16)}…
                      </div>
                    ) : null}
                  </div>
                  {art.downloadUrl ? (
                    <a
                      href={art.downloadUrl}
                      className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50 dark:border-slate-700"
                    >
                      Download
                    </a>
                  ) : null}
                </div>
              );
            }

            default:
              return null;
          }
        })}
      </div>

      {/* Operator review note + action buttons */}
      {Array.isArray(payload.actions) && payload.actions.length > 0 ? (
        <div className="space-y-2.5 border-t border-slate-200 pt-3 dark:border-slate-800">
          <input
            type="text"
            value={draft.note}
            onChange={(e) =>
              patchUiSurfaceDraft(chatId, payload.surfaceId, { note: e.target.value })
            }
            placeholder="Optional review note"
            aria-label="Optional review note"
            data-testid="ui-surface-note-input"
            className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-slate-500">
              {draft.selectedRowIds.length > 0
                ? `${draft.selectedRowIds.length} selected`
                : 'Ready'}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {payload.actions.map((action) => {
                const disabled =
                  isBusy ||
                  Boolean(action.requiresSelection && draft.selectedRowIds.length === 0);
                return (
                  <button
                    key={action.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => handleActionClick(action)}
                    data-testid={`ui-surface-action-${action.id}`}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                      action.variant === 'danger'
                        ? 'bg-rose-600 text-white hover:bg-rose-700'
                        : action.variant === 'secondary'
                          ? 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100'
                          : 'bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900'
                    }`}
                  >
                    {action.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
