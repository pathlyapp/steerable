import { afterEach, describe, expect, it, vi } from 'vitest';
import * as hostBridge from './host-bridge';
import { installHostPaste, requestHostPaste } from './host-paste';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function editable(): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute('contenteditable', 'true');
  document.body.appendChild(el);
  return el;
}

describe('requestHostPaste', () => {
  it('falls back to plain text when the rich clipboard command is denied', async () => {
    const readClipboard = vi.fn().mockRejectedValue(new Error('not allowed'));
    const readClipboardText = vi.fn().mockResolvedValue('你好');
    vi.spyOn(hostBridge, 'getHostBridge').mockReturnValue({
      readClipboard,
      readClipboardText,
    } as Partial<hostBridge.HostBridge> as hostBridge.HostBridge);
    const el = editable();
    const pasted: string[] = [];
    el.addEventListener('hostpaste', (event) => {
      pasted.push((event as CustomEvent<string>).detail);
    });

    requestHostPaste(el);

    await vi.waitFor(() => {
      expect(pasted).toEqual(['你好']);
    });
    expect(readClipboard).toHaveBeenCalledOnce();
    expect(readClipboardText).toHaveBeenCalledOnce();
  });

  it('menu paste leaves the composer alone while the terminal has focus', async () => {
    let menuPaste: (() => void) | undefined;
    const readClipboardText = vi.fn().mockResolvedValue('ls');
    vi.spyOn(hostBridge, 'getHostBridge').mockReturnValue({
      readClipboardText,
      onMenuPaste: (callback: () => void) => {
        menuPaste = callback;
      },
    } as Partial<hostBridge.HostBridge> as hostBridge.HostBridge);
    installHostPaste();
    const composer = editable();
    const pasted: string[] = [];
    composer.addEventListener('hostpaste', (event) => {
      pasted.push((event as CustomEvent<string>).detail);
    });
    composer.focus();
    const terminal = document.createElement('div');
    terminal.className = 'xterm';
    const helper = document.createElement('textarea');
    terminal.appendChild(helper);
    document.body.appendChild(terminal);
    helper.focus();

    menuPaste?.();

    await vi.waitFor(() => {
      expect(readClipboardText).toHaveBeenCalledOnce();
    });
    await Promise.resolve();
    expect(pasted).toEqual([]);
    expect(helper.value).toBe('');
  });
});
