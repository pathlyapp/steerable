import { useCallback, useEffect, useState } from 'react';
import { t } from '@/i18n';
import { getHostBridge, hasHostBridge } from '@/lib/host-bridge';

export type MemoryScopeTab = 'user' | 'workspace' | 'tenant';
export type MemoryPermissionMode = 'off' | 'ask' | 'auto';

export interface RefinementItemDto {
  id: string;
  normalizedHash: string;
  scope: MemoryScopeTab;
  content: string;
  humanEdited: boolean;
  status: 'active' | 'ordinary' | 'withdrawn';
  createdAt: string;
  expiresAt: string | null;
}

interface MemoryApiResponse {
  permissionMode: MemoryPermissionMode;
  scope: MemoryScopeTab;
  scopeId: string;
  contentMarkdown: string;
  contentSha256: string;
  bytesUsed: number;
  maxBytes: number;
  linesUsed: number;
  maxLines: number;
  refinements: RefinementItemDto[];
  revokedHashes: string[];
}

async function requestMemoryApi(
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  if (hasHostBridge()) {
    const bridge = getHostBridge();
    if (!bridge?.localBackend) return { status: 503, data: {} };
    try {
      const res = await bridge.localBackend.request<Record<string, unknown>>({
        method,
        path,
        body,
      });
      if (
        res &&
        typeof res === 'object' &&
        typeof (res as { status?: unknown }).status === 'number' &&
        'data' in res
      ) {
        return {
          status: Number((res as { status: number }).status),
          data: ((res as { data?: unknown }).data ?? {}) as Record<string, unknown>,
        };
      }
      return { status: 200, data: (res ?? {}) as Record<string, unknown> };
    } catch (err) {
      const status =
        typeof (err as { status?: unknown })?.status === 'number'
          ? Number((err as { status: number }).status)
          : 500;
      return {
        status,
        data: { message: err instanceof Error ? err.message : String(err) },
      };
    }
  }
  if (typeof fetch !== 'function' || !path.startsWith('http') && typeof window !== 'undefined' && window.location?.origin === 'null') {
    return { status: 503, data: {} };
  }
  try {
    const resp = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: resp.status, data: json };
  } catch {
    return { status: 503, data: {} };
  }
}

export interface MemorySettingsPanelProps {
  workspaceId?: string;
  showTenantTab?: boolean;
  isAdmin?: boolean;
}

export function MemorySettingsPanel({
  workspaceId = 'default',
  showTenantTab = false,
  isAdmin = true,
}: MemorySettingsPanelProps) {
  const [scope, setScope] = useState<MemoryScopeTab>('user');
  const [permissionMode, setPermissionMode] = useState<MemoryPermissionMode>('ask');
  const [markdown, setMarkdown] = useState('');
  const [baseHash, setBaseHash] = useState('');
  const [bytesUsed, setBytesUsed] = useState(0);
  const [maxBytes, setMaxBytes] = useState(16384);
  const [refinements, setRefinements] = useState<RefinementItemDto[]>([]);
  const [revokedHashes, setRevokedHashes] = useState<string[]>([]);
  const [conflictBanner, setConflictBanner] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadScope = useCallback(
    async (targetScope: MemoryScopeTab) => {
      const scopeParam =
        targetScope === 'workspace' ? `&scopeId=${encodeURIComponent(workspaceId)}` : '';
      const res = await requestMemoryApi(
        'GET',
        `/api/v2/memory?scope=${targetScope}${scopeParam}`,
      );
      if (res.status === 200) {
        const d = res.data as unknown as MemoryApiResponse;
        setPermissionMode(d.permissionMode ?? 'ask');
        setMarkdown(d.contentMarkdown ?? '');
        setBaseHash(d.contentSha256 ?? '');
        setBytesUsed(d.bytesUsed ?? 0);
        setMaxBytes(d.maxBytes || 16384);
        setRefinements(Array.isArray(d.refinements) ? d.refinements : []);
        setRevokedHashes(Array.isArray(d.revokedHashes) ? d.revokedHashes : []);
        setConflictBanner(false);
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    void loadScope(scope);
  }, [scope, loadScope]);

  const handleModeChange = async (nextMode: MemoryPermissionMode) => {
    setPermissionMode(nextMode);
    await requestMemoryApi('PUT', '/api/v2/memory', { permissionMode: nextMode });
  };

  const readOnly = scope === 'tenant' && !isAdmin;

  const handleSave = async () => {
    if (readOnly) return;
    setSaving(true);
    try {
      const res = await requestMemoryApi('PUT', '/api/v2/memory', {
        scope,
        ...(scope === 'workspace' ? { scopeId: workspaceId } : {}),
        contentMarkdown: markdown,
        baseHash,
      });
      if (res.status === 409) {
        setConflictBanner(true);
        return;
      }
      if (res.status === 200) {
        await loadScope(scope);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleRefinementAction = async (
    id: string,
    action: 'renew' | 'convert' | 'withdraw',
  ) => {
    await requestMemoryApi('POST', `/api/v2/memory/refinements/${encodeURIComponent(id)}/${action}`, {
      workspaceId,
    });
    await loadScope(scope);
  };

  const activeRefinements = refinements.filter((r) => r.status === 'active');
  const ratio = Math.min(100, Math.round((bytesUsed / Math.max(1, maxBytes)) * 100));

  return (
    <div
      data-testid="memory-settings-panel"
      className="space-y-4 rounded-xl border border-agent-border bg-agent-card p-4 text-xs"
    >
      {/* Top bar: permission mode + quota meter */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5" role="radiogroup" aria-label={t('Memory mode')}>
          {(
            [
              ['off', t('Off')],
              ['ask', t('Ask before saving')],
              ['auto', t('Remember automatically')],
            ] as const
          ).map(([val, label]) => (
            <button
              key={val}
              type="button"
              data-testid={`memory-mode-${val}`}
              onClick={() => void handleModeChange(val)}
              className={`rounded-md px-2.5 py-1 text-xs transition ${
                permissionMode === val
                  ? 'bg-agent-foreground font-semibold text-agent-background'
                  : 'border border-agent-border text-agent-muted-foreground hover:text-agent-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-agent-muted-foreground">
          <span data-testid="memory-quota-label">
            {(bytesUsed / 1024).toFixed(1)} / {(maxBytes / 1024).toFixed(1)} KB
          </span>
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-agent-border">
            <div className="h-full bg-agent-foreground" style={{ width: `${ratio}%` }} />
          </div>
        </div>
      </div>

      {/* Scope tabs */}
      <div className="flex items-center gap-2 border-b border-agent-border pb-2">
        <button
          type="button"
          data-testid="memory-tab-user"
          onClick={() => setScope('user')}
          className={`rounded px-2.5 py-1 ${
            scope === 'user' ? 'bg-agent-foreground/10 font-semibold' : 'text-agent-muted-foreground'
          }`}
        >
          {t('Personal memory')}
        </button>
        <button
          type="button"
          data-testid="memory-tab-workspace"
          onClick={() => setScope('workspace')}
          className={`rounded px-2.5 py-1 ${
            scope === 'workspace'
              ? 'bg-agent-foreground/10 font-semibold'
              : 'text-agent-muted-foreground'
          }`}
        >
          {t('Project memory')}
        </button>
        {showTenantTab ? (
          <button
            type="button"
            data-testid="memory-tab-tenant"
            onClick={() => setScope('tenant')}
            className={`rounded px-2.5 py-1 ${
              scope === 'tenant'
                ? 'bg-agent-foreground/10 font-semibold'
                : 'text-agent-muted-foreground'
            }`}
          >
            {t('Department shared rules')}
          </button>
        ) : null}
      </div>

      {/* Optimistic lock conflict banner */}
      {conflictBanner ? (
        <div
          role="alert"
          data-testid="memory-conflict-banner"
          className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-900 dark:text-amber-200"
        >
          <span>{t('Memory changed in another session. Reload before saving.')}</span>
          <button
            type="button"
            data-testid="memory-conflict-reload"
            onClick={() => void loadScope(scope)}
            className="rounded bg-amber-600 px-2 py-1 text-white"
          >
            {t('Reload')}
          </button>
        </div>
      ) : null}

      {/* MEMORY.md editor */}
      <div className="space-y-2">
        <textarea
          rows={6}
          readOnly={readOnly}
          value={markdown}
          onChange={(e) => setMarkdown(e.target.value)}
          aria-label={t('Memory markdown editor')}
          data-testid="memory-markdown-editor"
          className="w-full rounded-lg border border-agent-border bg-agent-background p-2.5 font-mono text-xs"
        />
        {!readOnly ? (
          <div className="flex justify-end">
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
              data-testid="memory-save-btn"
              className="rounded-md bg-agent-foreground px-3 py-1.5 text-xs font-medium text-agent-background disabled:opacity-50"
            >
              {t('Save memory')}
            </button>
          </div>
        ) : (
          <p className="text-[11px] text-agent-muted-foreground">
            {t('Read-only: only administrators can edit department shared rules.')}
          </p>
        )}
      </div>

      {/* Active RSI refinement review queue */}
      {activeRefinements.length > 0 ? (
        <div className="space-y-2 border-t border-agent-border pt-3">
          <div className="font-semibold text-agent-foreground">
            {t('Refinement notes pending review (30-day expiry)')}
          </div>
          {activeRefinements.map((item) => (
            <div
              key={item.id}
              data-testid={`memory-refinement-${item.id}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-agent-border p-2.5"
            >
              <div className="space-y-0.5">
                <div className="text-agent-foreground">{item.content}</div>
                <div className="font-mono text-[11px] text-agent-muted-foreground">
                  {item.id}
                  {item.expiresAt ? ` · ${t('Expires')} ${item.expiresAt.slice(0, 10)}` : ''}
                </div>
              </div>
              {!readOnly ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    data-testid={`memory-renew-${item.id}`}
                    onClick={() => void handleRefinementAction(item.id, 'renew')}
                    className="rounded border border-agent-border px-2 py-1 hover:bg-agent-foreground/5"
                  >
                    {t('Renew 30d')}
                  </button>
                  <button
                    type="button"
                    data-testid={`memory-convert-${item.id}`}
                    onClick={() => void handleRefinementAction(item.id, 'convert')}
                    className="rounded border border-agent-border px-2 py-1 hover:bg-agent-foreground/5"
                  >
                    {t('Make ordinary')}
                  </button>
                  <button
                    type="button"
                    data-testid={`memory-withdraw-${item.id}`}
                    onClick={() => void handleRefinementAction(item.id, 'withdraw')}
                    className="rounded border border-rose-500/40 px-2 py-1 text-rose-600 hover:bg-rose-500/10"
                  >
                    {t('Withdraw')}
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {/* Revoked hashes count */}
      {revokedHashes.length > 0 ? (
        <div className="text-[11px] text-agent-muted-foreground" data-testid="memory-revoked-summary">
          {t('{count} withdrawn items blocked from re-learning.', {
            count: String(revokedHashes.length),
          })}
        </div>
      ) : null}
    </div>
  );
}

export default MemorySettingsPanel;
