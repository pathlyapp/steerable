import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MODEL_IMAGE_MAX_DIMENSION,
  normalizeModelImageBuffer,
  normalizeToolImagePayload,
} from '../src/attachments/image-normalizer.js';
import { processImageAttachments, processViewImage } from '../src/image-attachment.js';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs') as {
  PNG: {
    new (options: { width: number; height: number }): {
      width: number;
      height: number;
      data: Buffer;
    };
    sync: {
      write(png: { width: number; height: number; data: Buffer }): Buffer;
    };
  };
};
const jpeg = require('jpeg-js') as {
  decode(buf: Buffer): { width: number; height: number };
};

/**
 * Synthesize a realistic 4K Retina desktop screenshot (> 512 KiB as PNG due to
 * smooth gradients + UI chrome, yet spatially coherent so JPEG quality 82
 * compresses it cleanly below 400 KiB — unlike white noise).
 */
function makeRetinaScreenshotPngBuffer(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const rowSeed = (y * 2654435761) >>> 0;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      // Smooth UI gradient + subtle deterministic dither so zlib PNG stays > 600 KiB
      // while 8x8 DCT blocks in JPEG compress cleanly like a real screen capture.
      const blockNoise = (((x >>> 2) * 374761393 + (y >>> 2) * 668265263 + rowSeed) >>> 24) & 0x1f;
      const fine = ((x * 17 + y * 31) & 0x07);
      png.data[idx] = ((x * 255) / width + blockNoise + fine) & 0xff;
      png.data[idx + 1] = ((y * 255) / height + blockNoise) & 0xff;
      png.data[idx + 2] = (((x + y) * 180) / (width + height) + (blockNoise ^ fine)) & 0xff;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe('Phase 10 R2 image-normalizer dual-track invariants (T-IMG-01, T-IMG-02)', () => {
  it('T-IMG-01: downscales 4K noisy PNG > 512 KiB to <= 1568px JPEG < 450 KiB while preserving original file SHA-256 on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p10-img-norm-'));
    try {
      const rawBuf = makeRetinaScreenshotPngBuffer(2400, 1600);
      expect(rawBuf.length).toBeGreaterThan(512 * 1024);

      const filePath = join(dir, 'retina-4k.png');
      writeFileSync(filePath, rawBuf);
      const shaBefore = createHash('sha256').update(readFileSync(filePath)).digest('hex');

      const attached = processImageAttachments([{ path: filePath, name: 'retina-4k.png' }]);
      expect(attached.images).toHaveLength(1);
      const proj = attached.images[0]!;
      expect(proj.mediaType).toBe('image/jpeg');
      const projBytes = Buffer.from(proj.data, 'base64');
      expect(projBytes.length).toBeLessThan(450 * 1024);

      const decodedProj = jpeg.decode(projBytes);
      expect(Math.max(decodedProj.width, decodedProj.height)).toBeLessThanOrEqual(
        MODEL_IMAGE_MAX_DIMENSION,
      );

      // Dual-track guarantee: original file on disk is 100% byte-identical!
      const shaAfter = createHash('sha256').update(readFileSync(filePath)).digest('hex');
      expect(shaAfter).toBe(shaBefore);

      // view_image default format also normalizes large PNG -> <=1568px JPEG
      const viewed = processViewImage({ path: filePath });
      expect(viewed.success).toBe(true);
      expect(viewed.data?.mediaType).toBe('image/jpeg');
      expect(Math.max(viewed.data?.width ?? 0, viewed.data?.height ?? 0)).toBeLessThanOrEqual(
        MODEL_IMAGE_MAX_DIMENSION,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T-IMG-02: normalizeToolImagePayload compresses Retina screenshot _image payloads and passes synthetic stubs untouched', () => {
    const stub = normalizeToolImagePayload({ b64: 'jpeg-data', media_type: 'image/jpeg' });
    expect(stub).toEqual({ b64: 'jpeg-data', media_type: 'image/jpeg' });

    const retinaPng = makeRetinaScreenshotPngBuffer(2200, 1400);
    const normalized = normalizeToolImagePayload({
      b64: retinaPng.toString('base64'),
      media_type: 'image/png',
    });
    expect(normalized.normalized).toBe(true);
    expect(normalized.media_type).toBe('image/jpeg');
    expect(normalized.width).toBe(1568);
    expect(Buffer.from(normalized.b64, 'base64').length).toBeLessThan(450 * 1024);

    // Small PNG under threshold & <=1568px stays untouched lossless PNG
    const tinyPng = new PNG({ width: 64, height: 64 });
    tinyPng.data.fill(200);
    const tinyBuf = PNG.sync.write(tinyPng);
    const tinyRes = normalizeModelImageBuffer(tinyBuf, 'image/png');
    expect(tinyRes.resized).toBe(false);
    expect(tinyRes.reencoded).toBe(false);
    expect(tinyRes.mediaType).toBe('image/png');
  });
});
