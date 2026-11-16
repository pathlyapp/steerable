/**
 * WKWebView paste does not carry clipboard text or files into the page. The
 * Edit menu shortcut emits `menu:paste`; this module reads the OS pasteboard
 * and writes it into the focused field.
 */

import {
  getHostBridge,
  type HostClipboard,
  type HostClipboardFile,
} from './host-bridge';

export type { HostClipboardFile } from './host-bridge';

let lastEditable: HTMLElement | null = null;
let composerPasteTarget: HTMLElement | null = null;
let installed = false;
/**
 * Pastes run one at a time so two reads cannot interleave, but a paste that
 * arrives during a read is queued instead of dropped: dropping it loses the
 * keystroke without any signal (a screenshot read used to take a second).
 */
let pasteQueue: Promise<void> = Promise.resolve();

/**
 * Content whose send remounts the composer. The keystroke was aimed at the
 * field being replaced, so it waits for the replacement instead of being
 * dropped. It expires so a stale pasteboard never lands in a later
 * conversation.
 */
let heldForComposer: { clipboard: HostClipboard; until: number } | null = null;
const HELD_PASTE_TTL_MS = 2_000;

/**
 * Remember the live chat composer. A menu paste uses it when no other field
 * is focused, including right after the empty-hero composer unmounts.
 */
export function setComposerPasteTarget(element: HTMLElement): void {
  composerPasteTarget = element;
  const held = heldForComposer;
  heldForComposer = null;
  if (held === null || Date.now() > held.until) return;
  insertHostClipboard(held.clipboard, element);
}

/** Drop the composer target when that element unmounts. */
export function releaseComposerPasteTarget(element: HTMLElement): void {
  if (composerPasteTarget === element) composerPasteTarget = null;
}

/**
 * Remember the field that should receive a menu paste after focus moves.
 *
 * `lastEditable` exists for the menu shortcut: opening the app menu takes key
 * focus, and the paste still belongs to the field the user was in. It is
 * dropped once focus lands on another control in the page, so a paste after
 * the user clicked elsewhere does not go back to a field they left.
 */
export function installHostPaste(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('focusin', (event) => {
    const target = event.target;
    if (isEditable(target)) lastEditable = target;
  });
  document.addEventListener('focusout', (event) => {
    if (event.target !== lastEditable) return;
    // A menu opens before focus settles, so decide on the next task.
    setTimeout(() => {
      if (lastEditable === null) return;
      const active = document.activeElement;
      const movedInsidePage = active instanceof HTMLElement && active !== document.body;
      if (movedInsidePage && !isEditable(active)) lastEditable = null;
    }, 0);
  });
  const bridge = getHostBridge();
  bridge?.onMenuPaste?.((clipboard) => {
    insertHostClipboard(clipboard);
  });
}

/**
 * Read the OS pasteboard and insert it into `target` or the focused field.
 *
 * Reads are serialised. A request that arrives while one is in flight is
 * queued, not dropped; the pasteboard is read when its turn comes so it
 * reflects what is current then.
 */
export function requestHostPaste(target?: HTMLElement | null): void {
  const bridge = getHostBridge();
  const readClipboard = bridge?.readClipboard;
  const readText = bridge?.readClipboardText;
  if (!readClipboard && !readText) return;
  pasteQueue = pasteQueue.then(() =>
    readHostClipboard(readClipboard, readText)
      .then((clip) => {
        insertHostClipboard(clip, target ?? null);
      })
      .catch((error: unknown) => {
        console.warn('[host-paste] clipboard read failed', error);
      }),
  );
}

/**
 * Prefer the rich pasteboard (text, files, screenshots). Desktop capabilities
 * may allow only `host_read_clipboard_text`; a denial of the rich command must
 * still insert plain text.
 */
function readHostClipboard(
  readClipboard: (() => Promise<HostClipboard>) | undefined,
  readText: (() => Promise<string>) | undefined,
): Promise<HostClipboard> {
  const plain = (): Promise<HostClipboard> => {
    if (!readText) return Promise.reject(new Error('clipboard text is unavailable'));
    return readText().then((text) => ({ text, files: [] }));
  };
  if (!readClipboard) return plain();
  return Promise.resolve()
    .then(() => readClipboard())
    .catch((error: unknown) => {
      if (!readText) throw error;
      return plain().catch(() => {
        throw error;
      });
    });
}

export function hostClipboardAvailable(): boolean {
  const bridge = getHostBridge();
  return (
    typeof bridge?.readClipboard === 'function' || typeof bridge?.readClipboardText === 'function'
  );
}

function insertHostClipboard(clipboard: HostClipboard, target: HTMLElement | null = null): void {
  if (target !== null && !target.isConnected) {
    // Sending the first message remounts the composer mid-read.
    heldForComposer = { clipboard, until: Date.now() + HELD_PASTE_TTL_MS };
    return;
  }
  const el = target ?? focusedEditable();
  if (el === null) return;
  if (clipboard.files.length > 0) insertHostFiles(clipboard.files, el);
  if (clipboard.text) insertHostText(clipboard.text, el);
}

function isEditable(target: EventTarget | null): target is HTMLElement {
  if (isTerminalInput(target) || !(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return target.isContentEditable || target.getAttribute('contenteditable') === 'true';
}

/**
 * xterm's hidden textarea. The terminal pastes into its PTY itself; text
 * written into this textarea never reaches the shell.
 */
function isTerminalInput(target: EventTarget | null): boolean {
  return target instanceof HTMLTextAreaElement && target.closest('.xterm') !== null;
}

function focusedEditable(): HTMLElement | null {
  if (isTerminalInput(document.activeElement)) return null;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.isConnected && isEditable(active)) return active;
  if (lastEditable?.isConnected && isEditable(lastEditable)) return lastEditable;
  if (composerPasteTarget?.isConnected && isEditable(composerPasteTarget)) {
    return composerPasteTarget;
  }
  return null;
}

function insertHostFiles(files: HostClipboardFile[], el: HTMLElement): void {
  if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
    el.dispatchEvent(new CustomEvent('hostpastefiles', { detail: files, cancelable: true }));
  }
}

function insertHostText(text: string, el: HTMLElement): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.readOnly || el.disabled) return;
    writeFormValue(el, text);
    return;
  }
  if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
    el.dispatchEvent(new CustomEvent('hostpaste', { detail: text }));
  }
}

function writeFormValue(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const next = `${el.value.slice(0, start)}${text}${el.value.slice(end)}`;
  const caret = start + text.length;
  const prototype =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(el, next);
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
