/**
 * Mandatory sidecar handle. The host calls `setSidecarSupervisor()` after the
 * complete Python sidecar has booted; CoreLoop and provider traffic route
 * through it.
 *
 * Kept in a dependency-light module (type-only import of the supervisor) so
 * RPC thin clients (`local-edit`, `skill-loader`) can read the handle without
 * pulling the LLM-service → storage → Electron graph into pure-Node test
 * contexts.
 */
import type { SidecarSupervisor } from './index.js';

let sidecarSupervisor: SidecarSupervisor | null = null;
let pendingSupervisor: Promise<SidecarSupervisor | null> | null = null;

export function setSidecarSupervisor(supervisor: SidecarSupervisor | null): void {
  sidecarSupervisor = supervisor;
}

/**
 * Register the in-flight boot promise so early callers (e.g. the renderer's
 * skills request racing sidecar boot) can await readiness instead of
 * observing a bare `null` and degrading. `main.ts` registers this
 * synchronously inside `maybeStartSidecar()`, before the first await.
 */
export function setSidecarSupervisorPending(
  pending: Promise<SidecarSupervisor | null> | null,
): void {
  pendingSupervisor = pending;
}

/** The supervised sidecar handle, when the sidecar path is active. */
export function getSidecarSupervisor(): SidecarSupervisor | null {
  return sidecarSupervisor;
}

export function isSidecarEnabled(): boolean {
  return sidecarSupervisor != null;
}

/**
 * Await the sidecar handle through boot: returns the live handle immediately
 * when already up, otherwise waits on the registered boot promise. Returns
 * null when no boot is in flight, boot failed, or the wait exceeds
 * `timeoutMs`; callers surface that as sidecar unavailable.
 */
export async function whenSidecarSupervisor(timeoutMs = 20_000): Promise<SidecarSupervisor | null> {
  const live = getSidecarSupervisor();
  if (live) return live;
  const pending = pendingSupervisor;
  if (!pending) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  // A rejected boot promise is surfaced by host startup; concurrent waiters
  // receive null and return their explicit sidecar-unavailable error.
  const settled = pending.catch(() => null);
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
