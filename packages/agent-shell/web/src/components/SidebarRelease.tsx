import { useCallback, useEffect, useState } from 'react';
import {
  sidebarReleaseView,
  type AppReleaseView,
} from '@/lib/app-release';
import {
  getHostBridge,
  type AppReleaseSnapshot,
} from '@/lib/host-bridge';
import { t } from '@/i18n';

export function useAppRelease(): AppReleaseView & { run: () => void } {
  const [snap, setSnap] = useState<AppReleaseSnapshot | null>(null);
  const [confirmedCurrent, setConfirmedCurrent] = useState(false);

  useEffect(() => {
    const app = getHostBridge()?.app;
    if (!app) return;
    let alive = true;
    void app.snapshot().then((next) => {
      if (alive) setSnap(next);
    }).catch(() => {});
    const off = app.onState((next) => {
      if (!alive) return;
      setSnap(next);
      if (next.phase !== 'idle') setConfirmedCurrent(false);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const run = useCallback(() => {
    const app = getHostBridge()?.app;
    if (!app || !snap || !snap.enabled) return;
    if (snap.phase !== 'idle' && snap.phase !== 'error' && snap.phase !== 'ready') return;
    const task = snap.phase === 'ready' ? app.install() : app.check();
    void task
      .then((next) => {
        setSnap(next);
        setConfirmedCurrent(next.phase === 'idle' && !next.availableVersion);
      })
      .catch((error: unknown) => {
        setConfirmedCurrent(false);
        setSnap({
          ...snap,
          phase: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, [snap]);

  return { ...sidebarReleaseView(snap, confirmedCurrent), run };
}

export function SidebarVersionLabel({ release }: { release: AppReleaseView }) {
  if (!release.version) return null;
  return (
    <span
      className="ml-auto text-[10px] tabular-nums text-agent-muted-foreground/70"
      data-testid="sidebar-app-version"
      title={t('Current version {version}', { version: release.version })}
    >
      v{release.version}
    </span>
  );
}
