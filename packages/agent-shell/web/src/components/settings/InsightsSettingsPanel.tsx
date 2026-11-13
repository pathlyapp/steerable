import { useCallback, useEffect, useState } from 'react';
import { LuChartBar } from 'react-icons/lu';
import { BRAND_NAME } from '@/brand';
import { t } from '@/i18n';
import { getHostBridge, hasHostBridge } from '@/lib/host-bridge';

type InsightsWire = {
  installId: string;
  shareBehavior: boolean;
  shareConversation: boolean;
  shareProfile: boolean;
  promptedAt?: string;
  apiBase?: string;
  profile: {
    displayName: string;
    email: string;
    company: string;
    note: string;
  };
  stats?: { events: number; turns: number; profile: number; pending: number };
};

const empty: InsightsWire = {
  installId: '',
  shareBehavior: false,
  shareConversation: false,
  shareProfile: false,
  profile: { displayName: '', email: '', company: '', note: '' },
  stats: { events: 0, turns: 0, profile: 0, pending: 0 },
};

export function InsightsConsentBanner() {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!hasHostBridge()) return;
    void getHostBridge()!
      .localBackend.request<InsightsWire>({ method: 'GET', path: '/api/v2/local-settings/insights' })
      .then((data) => {
        if (!data.promptedAt) setOpen(true);
      })
      .catch(() => {});
  }, []);

  const save = useCallback(async (upload: boolean) => {
    if (!hasHostBridge()) return;
    setSaving(true);
    try {
      await getHostBridge()!.localBackend.request({
        method: 'POST',
        path: '/api/v2/local-settings/insights',
        body: {
          shareBehavior: upload,
          shareConversation: upload,
          shareProfile: upload,
          markPrompted: true,
        },
      });
      setOpen(false);
    } catch {
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }, []);

  if (!open) return null;

  return (
    <div
      className="flex-shrink-0 border-t border-agent-border bg-agent-muted px-2.5 py-2"
      data-testid="insights-consent-banner"
      role="region"
      aria-label={t('Consent to help improve the product')}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-agent-foreground">{t('Help improve {brand}', { brand: BRAND_NAME })}</p>
          <p className="mt-1 text-xs leading-relaxed text-agent-muted-foreground">
            {t('Agree to upload data to the server to help improve the product. You can change this later in Settings.')}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={() => void save(true)}
            className="h-8 whitespace-nowrap rounded-full bg-agent-foreground px-3.5 text-xs text-agent-canvas disabled:opacity-50"
          >
            {t('Save')}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save(false)}
            className="h-8 whitespace-nowrap rounded-full border border-agent-border bg-agent-canvas px-3.5 text-xs text-agent-foreground disabled:opacity-50"
          >
            {t('Cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function InsightsSettingsPanel() {
  const [data, setData] = useState<InsightsWire>(empty);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!hasHostBridge()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getHostBridge()!.localBackend.request<InsightsWire>({
        method: 'GET',
        path: '/api/v2/local-settings/insights',
      });
      setData({ ...empty, ...res, profile: { ...empty.profile, ...res.profile } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!hasHostBridge()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await getHostBridge()!.localBackend.request<InsightsWire>({
        method: 'POST',
        path: '/api/v2/local-settings/insights',
        body: {
          shareBehavior: data.shareBehavior,
          shareConversation: data.shareConversation,
          shareProfile: data.shareProfile,
          markPrompted: true,
          apiBase: data.apiBase ?? '',
          displayName: data.profile.displayName,
          email: data.profile.email,
          company: data.profile.company,
          note: data.profile.note,
        },
      });
      setData({ ...empty, ...res, profile: { ...empty.profile, ...res.profile } });
      setStatus(t('Saved. Unchecked categories stay on this device only.'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const exportFile = async () => {
    if (!hasHostBridge()) return;
    setError(null);
    try {
      const bundle = await getHostBridge()!.localBackend.request<unknown>({
        method: 'GET',
        path: '/api/v2/insights/export',
      });
      const text = `${JSON.stringify(bundle, null, 2)}\n`;
      const saved = await getHostBridge()!.local?.saveTextFile?.({
        title: t('Export local insight records'),
        defaultPath: `deeppath-insights-${new Date().toISOString().slice(0, 10)}.json`,
        content: text,
      });
      if (saved?.canceled === false) setStatus(t('Saved to {path}', { path: saved.filePath ?? '' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const uploadNow = async () => {
    if (!hasHostBridge()) return;
    setError(null);
    try {
      const res = await getHostBridge()!.localBackend.request<{ ok: boolean; detail: string }>({
        method: 'POST',
        path: '/api/v2/insights/upload-local',
      });
      setStatus(
        res.ok
          ? t('Uploaded to the {brand} server', { brand: BRAND_NAME })
          : t('Upload failed. The records are still on this device. You can export a file and send it instead.'),
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const stats = data.stats ?? empty.stats!;

  return (
    <div className="space-y-3" data-testid="insights-settings-panel">
      <div className="rounded-agent-md border border-agent-border/60 bg-agent-muted/30 p-2.5 space-y-2">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
          <LuChartBar className="h-3.5 w-3.5 text-agent-muted-foreground" />
          {t('Help improve the product (behavior / conversations / user info are confirmed separately)')}
        </h4>
        <p className="text-[11px] text-agent-muted-foreground">
          {t(
            'Even if the user does not agree to upload, records stay on this device. You can export JSON and send it to the product team, or click "Upload now" once.',
          )}
        </p>
        {!hasHostBridge() ? (
          <p className="text-[11px] text-agent-muted-foreground">{t('Open this in the desktop app')}</p>
        ) : loading ? (
          <p className="text-[11px] text-agent-muted-foreground">{t('Loading…')}</p>
        ) : (
          <>
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={data.shareBehavior}
                onChange={(e) => setData((d) => ({ ...d, shareBehavior: e.target.checked }))}
              />
              <span>
                {t('Auto-upload')} <strong>{t('behavior')}</strong>
                <span className="block text-[10px] text-agent-muted-foreground">{t('Opens, sends, stuck settings, and so on. No question or answer text.')}</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={data.shareConversation}
                onChange={(e) => setData((d) => ({ ...d, shareConversation: e.target.checked }))}
              />
              <span>
                {t('Auto-upload')} <strong>{t('conversations')}</strong>
                <span className="block text-[10px] text-agent-muted-foreground">{t('Questions and answers (keys and user directories are redacted)')}</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={data.shareProfile}
                onChange={(e) => setData((d) => ({ ...d, shareProfile: e.target.checked }))}
              />
              <span>
                {t('Auto-upload')} <strong>{t('user info')}</strong>
                <span className="block text-[10px] text-agent-muted-foreground">{t('Separate from the two above. If unchecked, your name and email stay on this device only.')}</span>
              </span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['displayName', 'Name'],
                  ['email', 'Email'],
                  ['company', 'Company/team'],
                  ['note', 'Anything to tell us'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="space-y-1 text-[11px] text-agent-muted-foreground">
                  {t(label)}
                  <input
                    value={data.profile[key]}
                    onChange={(e) =>
                      setData((d) => ({ ...d, profile: { ...d.profile, [key]: e.target.value } }))
                    }
                    className="h-8 w-full rounded-agent-md border border-agent-border bg-agent-canvas px-2 text-xs text-agent-foreground"
                  />
                </label>
              ))}
            </div>
            <p className="text-[10px] text-agent-muted-foreground">
              {t(
                'Recorded on this device: behavior {events} / conversations {turns} / profile {profile}, pending upload {pending}',
                {
                  events: stats.events,
                  turns: stats.turns,
                  profile: stats.profile,
                  pending: stats.pending,
                },
              )}
              {data.installId ? ` · ${data.installId.slice(0, 8)}` : ''}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => void save()}
                className="h-8 rounded-full bg-agent-foreground px-4 text-xs text-agent-canvas"
              >
                {t('Save')}
              </button>
              <button
                type="button"
                onClick={() => void exportFile()}
                className="h-8 rounded-full border border-agent-border px-4 text-xs"
              >
                {t('Export a file for the developers')}
              </button>
              <button
                type="button"
                onClick={() => void uploadNow()}
                className="h-8 rounded-full border border-agent-border px-4 text-xs"
              >
                {t('Upload local records now')}
              </button>
            </div>
          </>
        )}
        {status && <p className="text-[10px] text-agent-muted-foreground">{status}</p>}
      </div>
      {error && (
        <div className="rounded-agent-md border border-agent-destructive/20 bg-agent-destructive/10 p-2.5 text-xs text-agent-destructive">
          {error}
        </div>
      )}
    </div>
  );
}
