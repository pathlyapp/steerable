/**
 * Multimodal ingress dual-track normalization (Phase 10 R2 / P1-03).
 *
 * Dual-track invariant:
 *   1. Original files on disk (attachments, exports, workspace files) are
 *      NEVER modified or overwritten — scripts, OCR, and user downloads
 *      always read byte-identical originals.
 *   2. Only the model-bound inline projection (`LlmImage` / `_image`) is
 *      downscaled so its long edge is <= `MODEL_IMAGE_MAX_DIMENSION` (1568px)
 *      and re-encoded to JPEG (`MODEL_IMAGE_JPEG_QUALITY` = 82) whenever the
 *      rendered payload exceeds `MODEL_IMAGE_REENCODE_THRESHOLD_BYTES`
 *      (512 KiB), preventing Retina/4K screenshots from blowing the 4 MiB
 *      gateway request body ceiling.
 */
import { decodeRasterBuffer } from '../raster-image.js';

/** Maximum long-edge dimension sent to vision models by default. */
export const MODEL_IMAGE_MAX_DIMENSION = 1568;
/** Re-encode lossless PNG projections to JPEG once they exceed 512 KiB. */
export const MODEL_IMAGE_REENCODE_THRESHOLD_BYTES = 512 * 1024;
/** Default JPEG quality when transcoding model-bound projections. */
export const MODEL_IMAGE_JPEG_QUALITY = 82;

export interface NormalizeModelImageOptions {
  maxEdge?: number;
  reencodeThresholdBytes?: number;
  jpegQuality?: number;
  /** Explicit output format requested by a caller (`view_image.format`). */
  forceFormat?: 'png' | 'jpeg';
}

export interface NormalizedModelImageBuffer {
  buffer: Buffer;
  mediaType: string;
  width: number;
  height: number;
  resized: boolean;
  reencoded: boolean;
}

function targetDimensions(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number; resized: boolean } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0, resized: false };
  if (width <= maxEdge && height <= maxEdge) {
    return { width, height, resized: false };
  }
  const scale = Math.min(maxEdge / width, maxEdge / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true,
  };
}

/**
 * Normalize an in-memory image buffer for model-visible projection.
 * Non-raster or synthetic test buffers pass through unchanged.
 */
export function normalizeModelImageBuffer(
  bytes: Buffer,
  mediaType: string,
  options: NormalizeModelImageOptions = {},
): NormalizedModelImageBuffer {
  const maxEdge = options.maxEdge ?? MODEL_IMAGE_MAX_DIMENSION;
  const threshold = options.reencodeThresholdBytes ?? MODEL_IMAGE_REENCODE_THRESHOLD_BYTES;
  const jpegQuality = options.jpegQuality ?? MODEL_IMAGE_JPEG_QUALITY;

  const decoded = decodeRasterBuffer(bytes, mediaType);
  if (decoded.isEmpty()) {
    return {
      buffer: bytes,
      mediaType,
      width: 0,
      height: 0,
      resized: false,
      reencoded: false,
    };
  }

  const { width: srcW, height: srcH } = decoded.getSize();
  const target = targetDimensions(srcW, srcH, maxEdge);
  const needsTranscodeCheck =
    options.forceFormat != null || bytes.length > threshold || target.resized;

  if (!needsTranscodeCheck) {
    return {
      buffer: bytes,
      mediaType,
      width: srcW,
      height: srcH,
      resized: false,
      reencoded: false,
    };
  }

  const rendered = target.resized
    ? decoded.resize({ width: target.width, height: target.height, quality: 'good' })
    : decoded;

  const naturalFormat: 'png' | 'jpeg' = mediaType === 'image/jpeg' ? 'jpeg' : 'png';
  const requestedFormat = options.forceFormat ?? naturalFormat;
  let outMediaType = requestedFormat === 'jpeg' ? 'image/jpeg' : 'image/png';
  let outBuffer =
    requestedFormat === 'jpeg' ? rendered.toJPEG(jpegQuality) : rendered.toPNG();
  let reencoded = requestedFormat !== naturalFormat;

  if (
    outBuffer.length > threshold &&
    options.forceFormat == null &&
    outMediaType !== 'image/jpeg'
  ) {
    outMediaType = 'image/jpeg';
    outBuffer = rendered.toJPEG(jpegQuality);
    reencoded = true;
  } else if (
    outBuffer.length > threshold &&
    options.forceFormat == null &&
    outMediaType === 'image/jpeg' &&
    !target.resized
  ) {
    const tighter = rendered.toJPEG(Math.min(jpegQuality, 75));
    if (tighter.length < outBuffer.length) {
      outBuffer = tighter;
      reencoded = true;
    }
  }

  const finalSize = rendered.getSize();
  return {
    buffer: outBuffer,
    mediaType: outMediaType,
    width: finalSize.width,
    height: finalSize.height,
    resized: target.resized,
    reencoded,
  };
}

export interface ToolImagePayload {
  b64: string;
  media_type: string;
}

/**
 * Normalize a `{ b64, media_type }` tool `_image` payload in-memory.
 * Synthetic non-raster base64 strings (unit test fixtures) pass through untouched.
 */
export function normalizeToolImagePayload(
  payload: ToolImagePayload,
  options?: NormalizeModelImageOptions,
): ToolImagePayload & { width?: number; height?: number; normalized?: boolean } {
  if (!payload || typeof payload.b64 !== 'string' || !payload.b64) {
    return payload;
  }
  let rawBytes: Buffer;
  try {
    rawBytes = Buffer.from(payload.b64, 'base64');
  } catch {
    return payload;
  }
  if (rawBytes.length < 8) {
    return payload;
  }
  const res = normalizeModelImageBuffer(
    rawBytes,
    payload.media_type || 'image/png',
    options,
  );
  if (!res.resized && !res.reencoded && res.buffer === rawBytes) {
    return payload;
  }
  return {
    b64: res.buffer.toString('base64'),
    media_type: res.mediaType,
    width: res.width,
    height: res.height,
    normalized: true,
  };
}
