import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getNativeClipboard } from '@earendil-works/pi-tui';

export interface ClipboardRead {
  image?: Uint8Array | null;
  text?: string | null;
}

/** File extension for a clipboard image, or null when the bytes are not a supported picture. */
export function imageExtension(bytes: Uint8Array): 'png' | 'jpg' | 'gif' | 'webp' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'webp';
  return null;
}

/** Write clipboard image bytes to a temp file the attachment path can send. */
export async function saveClipboardImage(bytes: Uint8Array): Promise<{ name: string; path: string } | null> {
  const ext = imageExtension(bytes);
  if (!ext) return null;
  const name = `clipboard-${randomUUID().slice(0, 8)}.${ext}`;
  const file = path.join(os.tmpdir(), `steerable-${name}`);
  await fs.writeFile(file, bytes);
  return { name, path: file };
}

/** Image first, then text. An empty clipboard returns an empty result. */
export async function writeSystemClipboard(text: string): Promise<void> {
  const clipboard = getNativeClipboard();
  if (!clipboard?.setText) throw new Error('clipboard unavailable');
  await clipboard.setText(text);
}

export async function readSystemClipboard(): Promise<ClipboardRead> {
  const clipboard = getNativeClipboard();
  if (!clipboard) return {};
  try {
    const image = await clipboard.getImage();
    if (image && image.length > 0) return { image };
  } catch (error) {
    void error;
  }
  try {
    const text = await clipboard.getText();
    if (text) return { text };
  } catch (error) {
    void error;
  }
  return {};
}
