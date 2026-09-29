import { afterEach, describe, expect, it, vi } from 'vitest';
import * as hostBridge from './host-bridge';
import { requestHostPaste } from './host-paste';

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
});
