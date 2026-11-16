import { afterEach, describe, expect, it, vi } from 'vitest';
import * as hostBridge from './host-bridge';
import {
  installHostPaste,
  releaseComposerPasteTarget,
  requestHostPaste,
  setComposerPasteTarget,
} from './host-paste';

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
    let menuPaste: ((clipboard: hostBridge.HostClipboard) => void) | undefined;
    const readClipboardText = vi.fn().mockResolvedValue('ls');
    vi.spyOn(hostBridge, 'getHostBridge').mockReturnValue({
      readClipboardText,
      onMenuPaste: (callback) => {
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

    menuPaste?.({ text: 'ls', files: [] });

    expect(readClipboardText).not.toHaveBeenCalled();
    expect(pasted).toEqual([]);
    expect(helper.value).toBe('');
    composer.focus();

    menuPaste?.({ text: '原生剪贴板', files: [] });

    expect(pasted).toEqual(['原生剪贴板']);
    expect(readClipboardText).not.toHaveBeenCalled();
  });

  it('pastes into the live composer after the focused field unmounts', async () => {
    const readClipboardText = vi.fn().mockResolvedValue('下一条');
    vi.spyOn(hostBridge, 'getHostBridge').mockReturnValue({
      readClipboardText,
    } as Partial<hostBridge.HostBridge> as hostBridge.HostBridge);
    installHostPaste();
    const gone = editable();
    gone.focus();
    gone.remove();
    const composer = editable();
    const pasted: string[] = [];
    composer.addEventListener('hostpaste', (event) => {
      pasted.push((event as CustomEvent<string>).detail);
    });
    setComposerPasteTarget(composer);
    const sink = document.createElement('button');
    document.body.appendChild(sink);
    sink.focus();
    try {
      requestHostPaste();
      await vi.waitFor(() => {
        expect(pasted).toEqual(['下一条']);
      });
    } finally {
      releaseComposerPasteTarget(composer);
    }
  });

  /**
   * Two Cmd+V in a row must both land. A slow read (a screenshot used to take
   * a second) dropped the second keystroke with no signal.
   */
  it('keeps a paste that arrives while another read is in flight', async () => {
    const pendingReads: Array<(text: string) => void> = [];
    const readClipboardText = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          pendingReads.push(resolve);
        }),
    );
    vi.spyOn(hostBridge, 'getHostBridge').mockReturnValue({
      readClipboardText,
    } as Partial<hostBridge.HostBridge> as hostBridge.HostBridge);
    const composer = editable();
    const pasted: string[] = [];
    composer.addEventListener('hostpaste', (event) => {
      pasted.push((event as CustomEvent<string>).detail);
    });
    composer.focus();

    requestHostPaste(composer);
    requestHostPaste(composer);
    requestHostPaste(composer);

    await vi.waitFor(() => {
      expect(pendingReads).toHaveLength(1);
    });
    pendingReads[0]?.('一');
    await vi.waitFor(() => {
      expect(pendingReads).toHaveLength(2);
    });
    pendingReads[1]?.('二');
    await vi.waitFor(() => {
      expect(pendingReads).toHaveLength(3);
    });
    pendingReads[2]?.('三');

    await vi.waitFor(() => {
      expect(pasted).toEqual(['一', '二', '三']);
    });
  });

  /**
   * Sending the first message remounts the composer. A paste aimed at the
   * field that is being replaced had no receiver and was dropped.
   */
  it('holds content for the composer that replaces a sent field', async () => {
    const readClipboardText = vi.fn().mockResolvedValue('发送后粘贴');
    vi.spyOn(hostBridge, 'getHostBridge').mockReturnValue({
      readClipboardText,
    } as Partial<hostBridge.HostBridge> as hostBridge.HostBridge);
    const sent = editable();
    sent.remove();

    requestHostPaste(sent);
    await vi.waitFor(() => {
      expect(readClipboardText).toHaveBeenCalledOnce();
    });

    const composer = editable();
    const pasted: string[] = [];
    composer.addEventListener('hostpaste', (event) => {
      pasted.push((event as CustomEvent<string>).detail);
    });
    setComposerPasteTarget(composer);

    expect(pasted).toEqual(['发送后粘贴']);
    releaseComposerPasteTarget(composer);
  });

  /** A paste aimed at a field that unmounted must not land elsewhere. */
  it('does not paste into a different field when the target unmounted', async () => {
    const readClipboardText = vi.fn().mockResolvedValue('目标已卸载');
    vi.spyOn(hostBridge, 'getHostBridge').mockReturnValue({
      readClipboardText,
    } as Partial<hostBridge.HostBridge> as hostBridge.HostBridge);
    const sent = editable();
    sent.remove();

    requestHostPaste(sent);
    await vi.waitFor(() => {
      expect(readClipboardText).toHaveBeenCalledOnce();
    });

    const composer = editable();
    const pasted: string[] = [];
    composer.addEventListener('hostpaste', (event) => {
      pasted.push((event as CustomEvent<string>).detail);
    });
    setComposerPasteTarget(composer);

    expect(pasted).toEqual(['目标已卸载']);
    releaseComposerPasteTarget(composer);
  });

  /** A held paste must not resurface in a conversation opened much later. */
  it('drops held content once its window has passed', async () => {
    const readClipboardText = vi.fn().mockResolvedValue('过期内容');
    vi.spyOn(hostBridge, 'getHostBridge').mockReturnValue({
      readClipboardText,
    } as Partial<hostBridge.HostBridge> as hostBridge.HostBridge);
    const sent = editable();
    sent.remove();

    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    requestHostPaste(sent);
    await vi.waitFor(() => {
      expect(readClipboardText).toHaveBeenCalledOnce();
    });

    now.mockReturnValue(1_000 + 60_000);
    const composer = editable();
    const pasted: string[] = [];
    composer.addEventListener('hostpaste', (event) => {
      pasted.push((event as CustomEvent<string>).detail);
    });
    setComposerPasteTarget(composer);

    expect(pasted).toEqual([]);
    releaseComposerPasteTarget(composer);
    now.mockRestore();
  });

  /**
   * The remembered field must not outlive the user's visit to it. A paste
   * after clicking elsewhere went to the field they had already left.
   */
  it('forgets a field once focus moves to another control', async () => {
    const readClipboardText = vi.fn().mockResolvedValue('旧字段');
    vi.spyOn(hostBridge, 'getHostBridge').mockReturnValue({
      readClipboardText,
    } as Partial<hostBridge.HostBridge> as hostBridge.HostBridge);
    installHostPaste();
    const abandoned = editable();
    const pastedIntoAbandoned: string[] = [];
    abandoned.addEventListener('hostpaste', (event) => {
      pastedIntoAbandoned.push((event as CustomEvent<string>).detail);
    });
    abandoned.focus();

    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(button);
    });
    // The focusout handler decides on the next task.
    await new Promise((resolve) => setTimeout(resolve, 10));

    requestHostPaste();
    await vi.waitFor(() => {
      expect(readClipboardText).toHaveBeenCalledOnce();
    });
    expect(pastedIntoAbandoned).toEqual([]);
  });

  /** Opening the app menu blurs the page; the field must survive that. */
  it('keeps the field when focus leaves the page for the menu', async () => {
    const readClipboardText = vi.fn().mockResolvedValue('菜单粘贴');
    vi.spyOn(hostBridge, 'getHostBridge').mockReturnValue({
      readClipboardText,
    } as Partial<hostBridge.HostBridge> as hostBridge.HostBridge);
    installHostPaste();
    const composer = editable();
    const pasted: string[] = [];
    composer.addEventListener('hostpaste', (event) => {
      pasted.push((event as CustomEvent<string>).detail);
    });
    composer.focus();
    composer.blur();
    await new Promise((resolve) => setTimeout(resolve, 10));

    requestHostPaste();
    await vi.waitFor(() => {
      expect(pasted).toEqual(['菜单粘贴']);
    });
  });
});
