import type { DraftBuffer } from './editor.js';

export interface PromptHistory {
  items: string[];
  index: number;
  saved: { text: string; cursor: number } | null;
}

const LIMIT = 100;

export function createPromptHistory(): PromptHistory {
  return { items: [], index: -1, saved: null };
}

/** Remember a sent line. Newest is first. A repeat of the latest line is kept once. */
export function rememberPrompt(history: PromptHistory, text: string): void {
  const trimmed = text.trim();
  history.index = -1;
  history.saved = null;
  if (!trimmed || history.items[0] === trimmed) return;
  history.items.unshift(trimmed);
  if (history.items.length > LIMIT) history.items.pop();
}

/** Typing leaves history browsing and keeps the text now in the composer. */
export function leavePromptHistory(history: PromptHistory): void {
  if (history.index < 0) return;
  history.index = -1;
  history.saved = null;
}

/**
 * Step through sent lines.
 * `direction` -1 is older, 1 is newer. Past the newest line restores the draft that was there before browsing.
 */
export function recallPrompt(history: PromptHistory, draft: DraftBuffer, direction: -1 | 1): boolean {
  if (history.items.length === 0) return false;
  const next = history.index - direction;
  if (next < -1 || next >= history.items.length) return false;
  if (history.index < 0) history.saved = { text: draft.text, cursor: draft.cursor };
  history.index = next;
  if (next < 0) {
    const saved = history.saved;
    history.saved = null;
    draft.text = saved?.text ?? '';
    draft.cursor = saved?.cursor ?? 0;
    return true;
  }
  draft.text = history.items[next] ?? '';
  draft.cursor = draft.text.length;
  return true;
}

export function onFirstLine(text: string, cursor: number): boolean {
  const at = clamp(cursor, text.length);
  return !text.slice(0, at).includes('\n');
}

export function onLastLine(text: string, cursor: number): boolean {
  const at = clamp(cursor, text.length);
  return !text.slice(at).includes('\n');
}

function clamp(cursor: number, length: number): number {
  return Math.max(0, Math.min(cursor, length));
}
