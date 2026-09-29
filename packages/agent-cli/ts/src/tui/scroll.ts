import { getKeybindings } from '@earendil-works/pi-tui';

import { ensureAgentKeybindings } from './keys.js';

const PAGE_OVERLAP = 4;

/** Page Up / Page Down scroll the transcript. `0` means the key belongs to the composer. */
export function transcriptPage(sequence: string): -1 | 1 | 0 {
  ensureAgentKeybindings();
  const keys = getKeybindings();
  if (keys.matches(sequence, 'tui.altScreen.pageUp')) return -1;
  if (keys.matches(sequence, 'tui.altScreen.pageDown')) return 1;
  return 0;
}

/** One page, keeping a few lines of overlap so the reader can see where they were. */
export function pageScrollLines(viewportHeight: number, direction: -1 | 1): number {
  const rows = Number.isFinite(viewportHeight) ? viewportHeight : 0;
  return direction * Math.max(1, Math.floor(rows) - PAGE_OVERLAP);
}
