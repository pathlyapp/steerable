/**
 * WKWebView paste does not carry clipboard text or files into the page. The
 * Edit menu shortcut emits `menu:paste`; this module reads the OS pasteboard
 * and writes it into the focused field.
 */

export interface HostClipboardFile {
  name: string;
  path?: string;
  dataBase64?: string;
  mime?: string;
}

export interface HostClipboard {
  text: string;
  files: HostClipboardFile[];
}
import { getHostBridge } from './electron-bridge';

let pending = false;
let lastEditable: HTMLElement | null = null;
let installed = false;

/** Remember the field that should receive a menu paste after focus moves. */
export function installHostPaste(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('focusin', (event) => {
    const target = event.target;
    if (isEditable(target)) lastEditable = target;
  });
  const bridge = getHostBridge();
  bridge?.onMenuPaste?.(() => {
    requestHostPaste();
  });
}

/** Read the OS pasteboard and insert it into `target` or the focused field. */
export function requestHostPaste(target?: HTMLElement | null): void {
  const bridge = getHostBridge();
  const readClipboard = bridge?.readClipboard;
  const readText = bridge?.readClipboardText;
  if ((!readClipboard && !readText) || pending) return;
  pending = true;
  const read = readClipboard
    ? readClipboard()
    : readText!().then((text) => ({ text, files: [] as HostClipboardFile[] }));
  void read
    .then((clip) => {
      if (clip.files.length > 0) insertHostFiles(clip.files, target ?? null);
      if (clip.text) insertHostText(clip.text, target ?? null);
    })
    .catch((error: unknown) => {
      console.warn('[host-paste] clipboard read failed', error);
    })
    .finally(() => {
      pending = false;
    });
}

export function hostClipboardAvailable(): boolean {
  const bridge = getHostBridge();
  return (
    typeof bridge?.readClipboard === 'function' || typeof bridge?.readClipboardText === 'function'
  );
}

function isEditable(target: EventTarget | null): target is HTMLElement {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function focusedEditable(): HTMLElement | null {
  if (isEditable(document.activeElement)) return document.activeElement;
  if (lastEditable?.isConnected) return lastEditable;
  return null;
}

function insertHostFiles(files: HostClipboardFile[], preferred: HTMLElement | null): void {
  const el = preferred?.isConnected ? preferred : focusedEditable();
  if (!el) return;
  if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
    el.dispatchEvent(new CustomEvent('hostpastefiles', { detail: files, cancelable: true }));
  }
}

function insertHostText(text: string, preferred: HTMLElement | null): void {
  const el = preferred?.isConnected ? preferred : focusedEditable();
  if (!el) return;
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
