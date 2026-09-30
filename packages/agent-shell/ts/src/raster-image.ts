/**
 * PNG/JPEG decode, crop, resize, and re-encode for the Node host.
 *
 * `view_image` used to require an injected {@link ImageDecoder} (Electron
 * `nativeImage`). The headless host has none, so any image larger than
 * `maxEdge` failed with "当前环境不能缩放". This decoder is the default.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'fs';
import { extname } from 'path';
import type { DecodedImage, ImageDecoder } from './image-attachment.js';

const require = createRequire(import.meta.url);

interface PngImage {
  width: number;
  height: number;
  data: Buffer;
}

interface PngModule {
  PNG: {
    new (options: { width: number; height: number }): PngImage;
    sync: {
      read(buffer: Buffer): PngImage;
      write(png: PngImage): Buffer;
    };
  };
}

const { PNG } = require('pngjs') as PngModule;
const jpeg = require('jpeg-js') as {
  decode: (typeof import('jpeg-js'))['decode'];
  encode: (typeof import('jpeg-js'))['encode'];
};

const RASTER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

/** True when the built-in decoder can read this path's extension. */
export function builtinRasterSupports(filePath: string): boolean {
  return RASTER_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * Decode a local PNG or JPEG into a crop/resize/encode surface.
 * Unreadable or unsupported files yield an empty image.
 */
export function createRasterImageDecoder(): ImageDecoder {
  return {
    createFromPath(filePath: string): DecodedImage {
      const decoded = decodeRasterFile(filePath);
      if (!decoded) return EMPTY_IMAGE;
      return new RasterImage(decoded.width, decoded.height, decoded.rgba);
    },
  };
}

interface DecodedRaster {
  width: number;
  height: number;
  rgba: Buffer;
}

function decodeRasterFile(filePath: string): DecodedRaster | null {
  if (!builtinRasterSupports(filePath)) return null;
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch {
    return null;
  }
  try {
    const ext = extname(filePath).toLowerCase();
    if (ext === '.png') {
      const png = PNG.sync.read(bytes);
      return { width: png.width, height: png.height, rgba: Buffer.from(png.data) };
    }
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    if (decoded.width < 1 || decoded.height < 1) return null;
    return {
      width: decoded.width,
      height: decoded.height,
      rgba: Buffer.from(decoded.data),
    };
  } catch {
    return null;
  }
}

class RasterImage implements DecodedImage {
  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly rgba: Buffer,
  ) {}

  isEmpty(): boolean {
    return this.width < 1 || this.height < 1 || this.rgba.length < this.width * this.height * 4;
  }

  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  crop(rect: { x: number; y: number; width: number; height: number }): DecodedImage {
    return new RasterImage(
      rect.width,
      rect.height,
      cropRgba(this.rgba, this.width, rect.x, rect.y, rect.width, rect.height),
    );
  }

  resize(options: { width?: number; height?: number; quality?: string }): DecodedImage {
    const width = options.width ?? this.width;
    const height = options.height ?? this.height;
    return new RasterImage(
      width,
      height,
      resizeRgba(this.rgba, this.width, this.height, width, height),
    );
  }

  toPNG(): Buffer {
    const png = new PNG({ width: this.width, height: this.height });
    this.rgba.copy(png.data);
    return PNG.sync.write(png);
  }

  toJPEG(quality: number): Buffer {
    const encoded = jpeg.encode(
      { data: this.rgba, width: this.width, height: this.height },
      quality,
    );
    return Buffer.from(encoded.data);
  }
}

const EMPTY_IMAGE: DecodedImage = {
  isEmpty: () => true,
  getSize: () => ({ width: 0, height: 0 }),
  crop: () => EMPTY_IMAGE,
  resize: () => EMPTY_IMAGE,
  toPNG: () => Buffer.alloc(0),
  toJPEG: () => Buffer.alloc(0),
};

function cropRgba(
  src: Buffer,
  srcWidth: number,
  x: number,
  y: number,
  width: number,
  height: number,
): Buffer {
  const dst = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++) {
    const srcStart = ((y + row) * srcWidth + x) * 4;
    src.copy(dst, row * width * 4, srcStart, srcStart + width * 4);
  }
  return dst;
}

/**
 * Area-average downscale. Each output pixel is the mean of the source
 * rectangle it covers, so a long screenshot can be sent under `maxEdge`
 * without aliasing into a single row of samples.
 */
function resizeRgba(
  src: Buffer,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Buffer {
  if (dstWidth === srcWidth && dstHeight === srcHeight) return Buffer.from(src);
  const dst = Buffer.alloc(Math.max(0, dstWidth * dstHeight * 4));
  if (dstWidth < 1 || dstHeight < 1) return dst;
  for (let y = 0; y < dstHeight; y++) {
    const y0 = Math.floor((y * srcHeight) / dstHeight);
    const y1 = Math.min(srcHeight, Math.max(y0 + 1, Math.ceil(((y + 1) * srcHeight) / dstHeight)));
    for (let x = 0; x < dstWidth; x++) {
      const x0 = Math.floor((x * srcWidth) / dstWidth);
      const x1 = Math.min(srcWidth, Math.max(x0 + 1, Math.ceil(((x + 1) * srcWidth) / dstWidth)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy++) {
        const row = sy * srcWidth;
        for (let sx = x0; sx < x1; sx++) {
          const i = (row + sx) * 4;
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          a += src[i + 3];
          count += 1;
        }
      }
      const o = (y * dstWidth + x) * 4;
      dst[o] = Math.round(r / count);
      dst[o + 1] = Math.round(g / count);
      dst[o + 2] = Math.round(b / count);
      dst[o + 3] = Math.round(a / count);
    }
  }
  return dst;
}
