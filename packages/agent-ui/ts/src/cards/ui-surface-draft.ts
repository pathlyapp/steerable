/**
 * Session-scoped draft state shared between `<UiSurfaceCard />` (inline) and
 * `<UiSurfaceWorkbench />` (right-panel workbench) so collapsing or switching
 * workbench tabs never discards user row selections, form edits, or notes.
 */

export interface UiSurfaceDraftState {
  readonly selectedRowIds: readonly string[];
  readonly formValues: Readonly<Record<string, string | number | boolean>>;
  readonly kvDiffOverrides: Readonly<Record<string, string>>;
  readonly note: string;
}

const EMPTY_DRAFT: UiSurfaceDraftState = Object.freeze({
  selectedRowIds: [],
  formValues: {},
  kvDiffOverrides: {},
  note: '',
});

const drafts = new Map<string, UiSurfaceDraftState>();
const listeners = new Map<string, Set<() => void>>();

function makeKey(chatId: string | undefined, surfaceId: string): string {
  return `${chatId || 'default'}::${surfaceId}`;
}

export function getUiSurfaceDraft(
  chatId: string | undefined,
  surfaceId: string,
): UiSurfaceDraftState {
  return drafts.get(makeKey(chatId, surfaceId)) ?? EMPTY_DRAFT;
}

export function patchUiSurfaceDraft(
  chatId: string | undefined,
  surfaceId: string,
  patch: Partial<UiSurfaceDraftState>,
): UiSurfaceDraftState {
  const key = makeKey(chatId, surfaceId);
  const prev = drafts.get(key) ?? EMPTY_DRAFT;
  const next: UiSurfaceDraftState = {
    selectedRowIds: patch.selectedRowIds ?? prev.selectedRowIds,
    formValues: patch.formValues
      ? { ...prev.formValues, ...patch.formValues }
      : prev.formValues,
    kvDiffOverrides: patch.kvDiffOverrides
      ? { ...prev.kvDiffOverrides, ...patch.kvDiffOverrides }
      : prev.kvDiffOverrides,
    note: patch.note !== undefined ? patch.note : prev.note,
  };
  drafts.set(key, next);
  const subs = listeners.get(key);
  if (subs) {
    for (const fn of subs) fn();
  }
  return next;
}

export function clearUiSurfaceDraft(
  chatId: string | undefined,
  surfaceId: string,
): void {
  const key = makeKey(chatId, surfaceId);
  drafts.delete(key);
  const subs = listeners.get(key);
  if (subs) {
    for (const fn of subs) fn();
  }
}

export function resetAllUiSurfaceDraftsForTests(): void {
  drafts.clear();
  listeners.clear();
}

export function subscribeUiSurfaceDraft(
  chatId: string | undefined,
  surfaceId: string,
  listener: () => void,
): () => void {
  const key = makeKey(chatId, surfaceId);
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) listeners.delete(key);
  };
}
