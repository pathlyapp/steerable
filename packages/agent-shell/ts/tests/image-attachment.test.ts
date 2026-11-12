import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs') as {
  PNG: {
    new (options: { width: number; height: number }): {
      width: number;
      height: number;
      data: Buffer;
    };
    sync: {
      read(buffer: Buffer): { width: number; height: number; data: Buffer };
      write(png: { width: number; height: number; data: Buffer }): Buffer;
    };
  };
};
const jpeg = require('jpeg-js') as {
  encode(image: { data: Buffer; width: number; height: number }, quality?: number): {
    data: Buffer;
  };
};
import {
  computeTargetSize,
  isImagePath,
  parseImageAttachments,
  processImageAttachments,
  processViewImage,
  IMAGE_MAX_ENCODED_BYTES,
  IMAGE_MAX_SOURCE_BYTES,
  type DecodedImage,
  type ImageDecoder,
} from '../src/image-attachment.js';

function fakeNativeImage(
  width: number,
  height: number,
  options: {
    crops?: unknown[];
    resizes?: unknown[];
    png?: Buffer;
    jpeg?: Buffer;
    empty?: boolean;
  } = {},
): DecodedImage {
  return {
    isEmpty: () => options.empty ?? false,
    getSize: () => ({ width, height }),
    crop: (rect) => {
      options.crops?.push(rect);
      return fakeNativeImage(rect.width, rect.height, options);
    },
    resize: (resizeOptions) => {
      options.resizes?.push(resizeOptions);
      return fakeNativeImage(
        resizeOptions.width ?? width,
        resizeOptions.height ?? height,
        options,
      );
    },
    toPNG: () => options.png ?? Buffer.from('png'),
    toJPEG: () => options.jpeg ?? Buffer.from('jpeg'),
  };
}

function writeRasterPng(
  filePath: string,
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number, number],
): void {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * width + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = a;
    }
  }
  writeFileSync(filePath, PNG.sync.write(png));
}

function withImageFile(run: (imagePath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'view-image-'));
  try {
    const imagePath = join(dir, 'slide.png');
    writeFileSync(imagePath, Buffer.from([137, 80, 78, 71]));
    run(imagePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('isImagePath', () => {
  it('按扩展名识别图片（大小写不敏感）', () => {
    expect(isImagePath('/a/b.png')).toBe(true);
    expect(isImagePath('/a/b.JPG')).toBe(true);
    expect(isImagePath('/a/b.jpeg')).toBe(true);
    expect(isImagePath('/a/b.webp')).toBe(true);
  });

  it('非图片扩展名返回 false', () => {
    expect(isImagePath('/a/b.txt')).toBe(false);
    expect(isImagePath('/a/b.ts')).toBe(false);
    expect(isImagePath('/a/noext')).toBe(false);
  });
});

describe('computeTargetSize', () => {
  it('未超限保持原尺寸', () => {
    expect(computeTargetSize(800, 600)).toEqual({ width: 800, height: 600, resized: false });
  });

  it('按长边等比缩小（宽图）', () => {
    const r = computeTargetSize(3136, 1568, 1568);
    expect(r.resized).toBe(true);
    expect(r.width).toBe(1568);
    expect(r.height).toBe(784);
  });

  it('按长边等比缩小（高图）', () => {
    const r = computeTargetSize(1000, 4000, 2000);
    expect(r.resized).toBe(true);
    expect(r.height).toBe(2000);
    expect(r.width).toBe(500);
  });

  it('从不上采样', () => {
    expect(computeTargetSize(100, 100, 1568).resized).toBe(false);
  });

  it('非法尺寸返回 0', () => {
    expect(computeTargetSize(0, 100)).toEqual({ width: 0, height: 0, resized: false });
  });
});

describe('parseImageAttachments', () => {
  it('非数组返回空', () => {
    expect(parseImageAttachments(undefined)).toEqual([]);
    expect(parseImageAttachments('x')).toEqual([]);
    expect(parseImageAttachments(null)).toEqual([]);
  });

  it('过滤掉缺 path / 非字符串 path / 非图片扩展', () => {
    const out = parseImageAttachments([
      { path: '/a/ok.png', name: 'ok.png' },
      { path: '/a/skip.txt' },
      { name: 'no-path.png' },
      { path: 123 },
      'not-an-object',
      { path: '/a/ok2.jpg' },
    ]);
    expect(out).toEqual([
      { path: '/a/ok.png', name: 'ok.png' },
      { path: '/a/ok2.jpg', name: undefined },
    ]);
  });
});

describe('processImageAttachments（非 Electron 宿主）', () => {
  it('文件不存在 → 记入说明，不产出图片', () => {
    const r = processImageAttachments([{ path: '/definitely/not/here.png', name: 'here.png' }]);
    expect(r.images).toEqual([]);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain('here.png');
    expect(r.notes[0]).toContain('不存在');
  });

  it('源文件超过字节上限 → 拒绝并说明', () => {
    const dir = mkdtempSync(join(tmpdir(), 'img-attach-'));
    try {
      const big = join(dir, 'big.png');
      writeFileSync(big, Buffer.alloc(IMAGE_MAX_SOURCE_BYTES + 1, 0));
      const r = processImageAttachments([{ path: big, name: 'big.png' }]);
      expect(r.images).toEqual([]);
      expect(r.notes[0]).toContain('超过');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('合法图片路径在无解码器环境下 → 说明而非崩溃', () => {
    const dir = mkdtempSync(join(tmpdir(), 'img-attach-'));
    try {
      const p = join(dir, 'ok.png');
      writeFileSync(p, Buffer.from([137, 80, 78, 71])); // PNG magic, 内容无所谓
      const r = processImageAttachments([{ path: p, name: 'ok.png' }], null);
      // 无解码器时原样把字节交给模型，不再只留路径。
      expect(r.images).toEqual([{
        data: Buffer.from([137, 80, 78, 71]).toString('base64'),
        mediaType: 'image/png',
      }]);
      expect(r.notes[0]).toContain('ok.png');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('processViewImage', () => {
  it('裁剪、缩放并把像素作为 _image 内容块返回', () => {
    withImageFile((imagePath) => {
      const crops: unknown[] = [];
      const resizes: unknown[] = [];
      const decoder: ImageDecoder = {
        createFromPath: () => fakeNativeImage(2000, 1000, { crops, resizes }),
      };

      const result = processViewImage(
        {
          path: imagePath,
          region: { x: 0.25, y: 0, w: 0.5, h: 1 },
          maxEdge: 500,
          format: 'jpeg',
        },
        decoder,
      );

      expect(crops).toEqual([{ x: 500, y: 0, width: 1000, height: 1000 }]);
      expect(resizes).toEqual([{ width: 500, height: 500, quality: 'good' }]);
      expect(result).toEqual({
        success: true,
        data: {
          width: 500,
          height: 500,
          sourcePath: imagePath,
          mediaType: 'image/jpeg',
          _image: {
            b64: Buffer.from('jpeg').toString('base64'),
            media_type: 'image/jpeg',
          },
        },
      });
    });
  });

  it('拒绝越界裁剪', () => {
    withImageFile((imagePath) => {
      const image = fakeNativeImage(100, 100);
      const result = processViewImage(
        { path: imagePath, region: { x: 80, y: 0, w: 30, h: 10 } },
        { createFromPath: () => image },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('超出图片范围');
    });
  });

  it('像素裁剪不与 0–1 比例裁剪混淆', () => {
    withImageFile((imagePath) => {
      const crops: unknown[] = [];
      const result = processViewImage(
        { path: imagePath, region: { x: 2, y: 3, w: 10, h: 20 } },
        { createFromPath: () => fakeNativeImage(100, 100, { crops }) },
      );
      expect(result.success).toBe(true);
      expect(crops).toEqual([{ x: 2, y: 3, width: 10, height: 20 }]);
      expect(result.data).toMatchObject({ width: 10, height: 20 });
    });
  });

  it('PNG 超过编码上限时自动回退 JPEG；显式 PNG 则给出可恢复错误', () => {
    withImageFile((imagePath) => {
      const decoder = {
        createFromPath: () =>
          fakeNativeImage(100, 100, {
            png: Buffer.alloc(IMAGE_MAX_ENCODED_BYTES + 1),
            jpeg: Buffer.from('small-jpeg'),
          }),
      };
      const fallback = processViewImage({ path: imagePath }, decoder);
      expect(fallback.success).toBe(true);
      expect(fallback.data?.mediaType).toBe('image/jpeg');

      const explicitPng = processViewImage({ path: imagePath, format: 'png' }, decoder);
      expect(explicitPng.success).toBe(false);
      expect(explicitPng.needsFollowup).toBe(true);
      expect(explicitPng.error).toContain('maxEdge');
    });
  });

  it.each([0, 4097, 1.5])('拒绝非法 maxEdge=%s', (maxEdge) => {
    withImageFile((imagePath) => {
      const result = processViewImage(
        { path: imagePath, maxEdge },
        { createFromPath: () => fakeNativeImage(100, 100) },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('maxEdge');
    });
  });

  it('拒绝非图片扩展、缺失文件和空图片，无解码器时发送原图', () => {
    const decoder = { createFromPath: () => fakeNativeImage(10, 10) };
    expect(processViewImage({ path: '/tmp/a.txt' }, decoder).error).toContain('supports');
    expect(processViewImage({ path: '/definitely/missing.png' }, decoder).error).toContain(
      '不存在',
    );
    withImageFile((imagePath) => {
      const passed = processViewImage({ path: imagePath }, null);
      expect(passed.success).toBe(true);
      expect(passed.data?._image.b64).toBe(Buffer.from([137, 80, 78, 71]).toString('base64'));
      expect(processViewImage({ path: imagePath }).error).toContain('可识别');
      expect(processViewImage({ path: imagePath, region: { x: 0, y: 0, w: 1, h: 1 } }, null).error).toContain(
        '不能裁剪',
      );
      expect(
        processViewImage(
          { path: imagePath },
          { createFromPath: () => fakeNativeImage(10, 10, { empty: true }) },
        ).error,
      ).toContain('可识别');
    });
  });
});

describe('内置 PNG/JPEG 解码器', () => {
  it('长边超过 maxEdge 时缩放，而不是拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'view-image-raster-'));
    try {
      const imagePath = join(dir, 'sheet.png');
      writeRasterPng(imagePath, 2000, 8, (x) => (x < 1000 ? [255, 0, 0, 255] : [0, 0, 255, 255]));

      const scaled = processViewImage({ path: imagePath, maxEdge: 1500 });
      expect(scaled.success).toBe(true);
      expect(scaled.data).toMatchObject({ width: 1500, height: 6, mediaType: 'image/png' });
      const pixels = PNG.sync.read(Buffer.from(scaled.data?._image.b64 ?? '', 'base64'));
      expect(pixels.width).toBe(1500);
      expect(pixels.height).toBe(6);
      expect(pixels.data[0]).toBeGreaterThan(200);
      expect(pixels.data[1499 * 4 + 2]).toBeGreaterThan(200);

      const fallback = processViewImage({ path: imagePath }, null);
      expect(fallback.success).toBe(false);
      expect(fallback.error).toContain('不能缩放');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('按像素裁剪后再编码', () => {
    const dir = mkdtempSync(join(tmpdir(), 'view-image-crop-'));
    try {
      const imagePath = join(dir, 'crop.png');
      writeRasterPng(imagePath, 40, 30, () => [10, 20, 30, 255]);
      const result = processViewImage({
        path: imagePath,
        region: { x: 4, y: 6, w: 10, h: 8 },
      });
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ width: 10, height: 8, mediaType: 'image/png' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('JPEG 超长边时缩成 JPEG', () => {
    const dir = mkdtempSync(join(tmpdir(), 'view-image-jpeg-'));
    try {
      const width = 80;
      const height = 40;
      const rgba = Buffer.alloc(width * height * 4, 255);
      const imagePath = join(dir, 'photo.jpg');
      writeFileSync(imagePath, jpeg.encode({ data: rgba, width, height }, 90).data);

      const result = processViewImage({ path: imagePath, maxEdge: 20 });
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ width: 20, height: 10, mediaType: 'image/jpeg' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('附件里的超大 PNG 记入缩放说明', () => {
    const dir = mkdtempSync(join(tmpdir(), 'view-image-attach-'));
    try {
      const imagePath = join(dir, 'wide.png');
      writeRasterPng(imagePath, 2000, 4, () => [0, 0, 0, 255]);
      const attached = processImageAttachments([{ path: imagePath, name: 'wide.png' }]);
      expect(attached.images).toHaveLength(1);
      expect(attached.images[0]?.mediaType).toBe('image/png');
      expect(attached.notes[0]).toContain('已缩放至 1568×3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
