import { decodeKittyPrintable, getKeybindings } from '@earendil-works/pi-tui';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export interface DraftBuffer {
  text: string;
  cursor: number;
}

interface Grapheme {
  start: number;
  end: number;
  text: string;
}

export function createDraft(): DraftBuffer {
  return { text: '', cursor: 0 };
}

export function clearDraft(draft: DraftBuffer): void {
  draft.text = '';
  draft.cursor = 0;
}

export function insertText(draft: DraftBuffer, text: string): void {
  const at = clamp(draft.cursor, draft.text.length);
  draft.text = draft.text.slice(0, at) + text + draft.text.slice(at);
  draft.cursor = at + text.length;
}

/** Place the caret inside `text`. `head` is the grapheme under an insert cursor. */
export function splitAtCursor(text: string, cursor: number): { before: string; head: string; after: string } {
  const at = clamp(cursor, text.length);
  const rest = text.slice(at);
  const head = graphemesOf(rest)[0]?.text ?? '';
  return { before: text.slice(0, at), head, after: rest.slice(head.length) };
}

/**
 * Apply one composer key.
 * `submit` leaves the buffer unchanged so the caller can send it.
 */
export function editDraft(draft: DraftBuffer, data: string): 'submit' | 'edited' | 'ignored' {
  const keys = getKeybindings();
  if (keys.matches(data, 'tui.input.newLine') || isLegacyNewline(data)) {
    insertText(draft, '\n');
    return 'edited';
  }
  if (keys.matches(data, 'tui.input.submit')) return 'submit';
  if (keys.matches(data, 'tui.editor.deleteCharBackward')) {
    deleteSpan(draft, previousGrapheme(draft.text, draft.cursor), draft.cursor);
    return 'edited';
  }
  if (keys.matches(data, 'tui.editor.deleteCharForward')) {
    deleteSpan(draft, draft.cursor, nextGrapheme(draft.text, draft.cursor));
    return 'edited';
  }
  if (keys.matches(data, 'tui.editor.deleteWordBackward')) {
    deleteSpan(draft, wordBoundary(draft.text, draft.cursor, -1), draft.cursor);
    return 'edited';
  }
  if (keys.matches(data, 'tui.editor.deleteWordForward')) {
    deleteSpan(draft, draft.cursor, wordBoundary(draft.text, draft.cursor, 1));
    return 'edited';
  }
  if (keys.matches(data, 'tui.editor.deleteToLineStart')) {
    deleteSpan(draft, lineStart(draft.text, draft.cursor), draft.cursor);
    return 'edited';
  }
  if (keys.matches(data, 'tui.editor.deleteToLineEnd')) {
    deleteSpan(draft, draft.cursor, lineEnd(draft.text, draft.cursor));
    return 'edited';
  }
  if (keys.matches(data, 'tui.editor.cursorLeft')) {
    draft.cursor = previousGrapheme(draft.text, draft.cursor);
    return 'edited';
  }
  if (keys.matches(data, 'tui.editor.cursorRight')) {
    draft.cursor = nextGrapheme(draft.text, draft.cursor);
    return 'edited';
  }
  if (keys.matches(data, 'tui.editor.cursorLineStart')) {
    draft.cursor = lineStart(draft.text, draft.cursor);
    return 'edited';
  }
  if (keys.matches(data, 'tui.editor.cursorLineEnd')) {
    draft.cursor = lineEnd(draft.text, draft.cursor);
    return 'edited';
  }
  if (keys.matches(data, 'tui.editor.cursorWordLeft')) {
    draft.cursor = wordBoundary(draft.text, draft.cursor, -1);
    return 'edited';
  }
  if (keys.matches(data, 'tui.editor.cursorWordRight')) {
    draft.cursor = wordBoundary(draft.text, draft.cursor, 1);
    return 'edited';
  }
  if (keys.matches(data, 'tui.editor.cursorUp')) {
    draft.cursor = moveLine(draft.text, draft.cursor, -1);
    return 'edited';
  }
  if (keys.matches(data, 'tui.editor.cursorDown')) {
    draft.cursor = moveLine(draft.text, draft.cursor, 1);
    return 'edited';
  }
  const kitty = decodeKittyPrintable(data);
  if (kitty) {
    insertText(draft, kitty);
    return 'edited';
  }
  if (isPrintable(data)) {
    insertText(draft, data);
    return 'edited';
  }
  return 'ignored';
}

function deleteSpan(draft: DraftBuffer, from: number, to: number): void {
  const start = clamp(Math.min(from, to), draft.text.length);
  const end = clamp(Math.max(from, to), draft.text.length);
  if (start === end) return;
  draft.text = draft.text.slice(0, start) + draft.text.slice(end);
  draft.cursor = start;
}

function previousGrapheme(text: string, cursor: number): number {
  const at = clamp(cursor, text.length);
  const prior = graphemesOf(text).filter((part) => part.end <= at);
  return prior[prior.length - 1]?.start ?? 0;
}

function nextGrapheme(text: string, cursor: number): number {
  const at = clamp(cursor, text.length);
  return graphemesOf(text).find((part) => part.start >= at)?.end ?? text.length;
}

function lineStart(text: string, cursor: number): number {
  const at = clamp(cursor, text.length);
  if (at === 0) return 0;
  const index = text.lastIndexOf('\n', at - 1);
  return index < 0 ? 0 : index + 1;
}

function lineEnd(text: string, cursor: number): number {
  const at = clamp(cursor, text.length);
  const index = text.indexOf('\n', at);
  return index < 0 ? text.length : index;
}

function wordBoundary(text: string, cursor: number, direction: -1 | 1): number {
  const parts = graphemesOf(text);
  const at = clamp(cursor, text.length);
  if (direction < 0) {
    let index = -1;
    for (let part = 0; part < parts.length; part += 1) {
      if ((parts[part]?.end ?? 0) <= at) index = part;
    }
    while (index >= 0 && isSpace(parts[index]?.text ?? '')) index -= 1;
    while (index >= 0 && !isSpace(parts[index]?.text ?? '')) index -= 1;
    return parts[index + 1]?.start ?? 0;
  }
  let index = parts.findIndex((part) => part.start >= at);
  if (index < 0) return text.length;
  while (index < parts.length && isSpace(parts[index]?.text ?? '')) index += 1;
  while (index < parts.length && !isSpace(parts[index]?.text ?? '')) index += 1;
  return parts[index - 1]?.end ?? text.length;
}

function moveLine(text: string, cursor: number, direction: -1 | 1): number {
  const at = clamp(cursor, text.length);
  const start = lineStart(text, at);
  const column = graphemesOf(text.slice(start, at)).length;
  if (direction < 0) {
    if (start === 0) return at;
    const previousEnd = start - 1;
    return columnOnLine(text, lineStart(text, previousEnd), previousEnd, column);
  }
  const end = lineEnd(text, at);
  if (end >= text.length) return at;
  const nextStart = end + 1;
  return columnOnLine(text, nextStart, lineEnd(text, nextStart), column);
}

function columnOnLine(text: string, start: number, end: number, column: number): number {
  const parts = graphemesOf(text.slice(start, end));
  if (column >= parts.length) return end;
  return start + (parts[column]?.start ?? 0);
}

function graphemesOf(text: string): Grapheme[] {
  return [...segmenter.segment(text)].map((part) => ({
    start: part.index,
    end: part.index + part.segment.length,
    text: part.segment,
  }));
}

function isSpace(text: string): boolean {
  return text.length > 0 && /^\s+$/u.test(text);
}

function isLegacyNewline(data: string): boolean {
  if (data === '\x1b\r' || data === '\x1b[13;2~') return true;
  return data.length > 1 && data.includes('\x1b') && data.includes('\r');
}

function isPrintable(data: string): boolean {
  if (data.length === 0) return false;
  return [...data].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 32 && code !== 0x7f && (code < 0x80 || code > 0x9f);
  });
}

function clamp(cursor: number, length: number): number {
  return Math.max(0, Math.min(cursor, length));
}
