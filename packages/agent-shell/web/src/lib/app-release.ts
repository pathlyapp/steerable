import { t } from '@/i18n';
import type { AppReleasePhase, AppReleaseSnapshot } from './host-bridge';

export interface AppReleaseView {
  version: string | null;
  actionLabel: string | null;
  actionTitle?: string;
  clickable: boolean;
  /** 已下载、可以重启安装。 */
  emphasize: boolean;
}

export function sidebarUpdateClickable(phase: AppReleasePhase): boolean {
  return phase === 'idle' || phase === 'error' || phase === 'ready';
}

export function sidebarUpdateLabel(
  snap: AppReleaseSnapshot,
  confirmedCurrent: boolean,
): string | null {
  if (!snap.enabled || snap.phase === 'disabled') return null;
  switch (snap.phase) {
    case 'checking':
      return t('Checking');
    case 'downloading':
      return typeof snap.percent === 'number'
        ? t('Downloading {percent}%', { percent: Math.round(snap.percent) })
        : t('Downloading…');
    case 'ready':
      return snap.availableVersion
        ? t('Update to {version}', { version: snap.availableVersion })
        : t('Update');
    case 'installing':
      return t('Installing');
    case 'error':
      return t('Retry');
    case 'idle':
      if (snap.availableVersion) return t('{version} available', { version: snap.availableVersion });
      if (snap.message) return snap.message;
      return confirmedCurrent ? t('Up to date') : t('Check for updates');
    default:
      return t('Check for updates');
  }
}

export function sidebarUpdateTitle(snap: AppReleaseSnapshot): string | undefined {
  if (snap.phase === 'error' || (snap.phase === 'idle' && snap.availableVersion)) {
    return snap.message;
  }
  if (snap.phase === 'ready' && snap.availableVersion) {
    return t('Restart and install {version}', { version: snap.availableVersion });
  }
  if (snap.phase === 'downloading') return t('Downloading update');
  return undefined;
}

export function sidebarReleaseView(
  snap: AppReleaseSnapshot | null,
  confirmedCurrent: boolean,
): AppReleaseView {
  if (!snap?.version) {
    return { version: null, actionLabel: null, clickable: false, emphasize: false };
  }
  return {
    version: snap.version,
    actionLabel: sidebarUpdateLabel(snap, confirmedCurrent),
    actionTitle: sidebarUpdateTitle(snap),
    clickable: snap.enabled && sidebarUpdateClickable(snap.phase),
    emphasize: snap.phase === 'ready',
  };
}
