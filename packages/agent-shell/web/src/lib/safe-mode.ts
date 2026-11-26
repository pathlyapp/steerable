import { getHostBridge, hasHostBridge } from './host-bridge';

export type HiddenNavItem = 'skills' | 'mcp' | 'agents' | 'terminal';

export interface ActiveApplicationState {
  readonly id: string;
  readonly title: Readonly<Record<string, string>>;
  readonly defaultAgentProfileId: string;
  readonly allowedPackIds: readonly string[];
  readonly defaultWorkbenchTabs: readonly string[];
  readonly hiddenNavItems: readonly HiddenNavItem[];
  readonly safeMode: boolean;
  readonly customApplicationBypassed: boolean;
}

/**
 * Detects `/?safe=1` (or `#/...?safe=1`) safe recovery mode so operators can
 * always bypass a broken or overly restrictive ApplicationManifest.
 */
export function isSafeRecoveryMode(
  loc: Pick<Location, 'search' | 'hash'> | undefined =
    typeof window !== 'undefined' ? window.location : undefined,
): boolean {
  if (!loc) return false;
  if (new URLSearchParams(loc.search).get('safe') === '1') return true;
  const hashQueryIdx = loc.hash.indexOf('?');
  if (hashQueryIdx >= 0) {
    const hashParams = new URLSearchParams(loc.hash.slice(hashQueryIdx + 1));
    if (hashParams.get('safe') === '1') return true;
  }
  return false;
}

/** Strips `safe=1` from both `location.search` and `location.hash` after reset. */
export function stripSafeQueryParam(href: string): string {
  try {
    const url = new URL(href, 'http://localhost');
    url.searchParams.delete('safe');
    if (url.hash.includes('?')) {
      const [hashPath, rawQuery] = url.hash.split('?', 2);
      const hp = new URLSearchParams(rawQuery);
      hp.delete('safe');
      const qs = hp.toString();
      url.hash = qs ? `${hashPath}?${qs}` : hashPath;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '#/';
  }
}

export async function fetchActiveApplication(
  safeMode: boolean,
): Promise<ActiveApplicationState | null> {
  if (!hasHostBridge()) return null;
  const b = getHostBridge();
  if (!b) return null;
  try {
    const data = await b.localBackend.request<{ application?: ActiveApplicationState }>({
      method: 'GET',
      path: `/api/v2/applications/active${safeMode ? '?safe=1' : ''}`,
    });
    return data?.application ?? null;
  } catch {
    return null;
  }
}

export async function resetToDefaultApplication(): Promise<boolean> {
  if (!hasHostBridge()) return false;
  const b = getHostBridge();
  if (!b) return false;
  try {
    const data = await b.localBackend.request<{ application?: ActiveApplicationState }>({
      method: 'POST',
      path: '/api/v2/applications/reset',
      body: {},
    });
    return Boolean(data?.application);
  } catch {
    return false;
  }
}
