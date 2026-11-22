import crypto from 'node:crypto';
import { sanitizeUntrustedField } from './safety.js';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 单张图片上限 2MB

/**
 * 纯 Node.js 魔数校验：仅放行真实 PNG / JPEG / WebP，拦截伪装成图片的 SVG/HTML/可执行脚本
 */
export function detectSafeImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // WebP: RIFF .... WEBP
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

/**
 * 零依赖轻量级元数据/夹带特征初筛（不下载任何 ONNX/OCR 模型）
 * 深度视觉审核（NSFW、二维码、收款码、引流文字）直接交由用户自己的多模态 AI 完成。
 */
export function inspectBinaryMetadata(buffer) {
  const warnings = [];
  const sample = buffer.toString('latin1');
  if (/<script[\s>]|javascript:|<\?php/i.test(sample)) {
    warnings.push('图片二进制块中检测到可疑脚本标签');
  }
  if (/https?:\/\/(?:bit\.ly|tinyurl\.com|t\.co|dwz\.cn|cutt\.ly|rb\.gy)\//i.test(sample)) {
    warnings.push('图片元数据中检测到可疑短链接');
  }
  return warnings;
}

function stripJpegMetadata(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return { buffer, strippedBytes: 0 };
  }

  const STRIP_MARKERS = new Set([0xe1, 0xed, 0xfe]); // APP1(EXIF/XMP), APP13(IPTC), COM
  const chunks = [buffer.subarray(0, 2)]; // SOI
  let offset = 2;
  let strippedBytes = 0;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      return { buffer, strippedBytes: 0 };
    }

    const markerStart = offset;
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= buffer.length) {
      return { buffer, strippedBytes: 0 };
    }

    const marker = buffer[offset];
    offset += 1;

    // SOS (0xDA) 后为压缩熵编码图像流，原样保留至文件尾；EOI (0xD9) 也直接结束
    if (marker === 0xda || marker === 0xd9) {
      chunks.push(buffer.subarray(markerStart));
      break;
    }

    // 无长度字节的独立 marker (RST0-7, TEM, 0x00)
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      chunks.push(buffer.subarray(markerStart, offset));
      continue;
    }

    if (offset + 2 > buffer.length) {
      return { buffer, strippedBytes: 0 };
    }

    const segLen = buffer.readUInt16BE(offset);
    const segEnd = offset + segLen;
    if (segLen < 2 || segEnd > buffer.length) {
      return { buffer, strippedBytes: 0 };
    }

    if (STRIP_MARKERS.has(marker)) {
      strippedBytes += segEnd - markerStart;
    } else {
      chunks.push(buffer.subarray(markerStart, segEnd));
    }

    offset = segEnd;
  }

  if (strippedBytes === 0) {
    return { buffer, strippedBytes: 0 };
  }
  return { buffer: Buffer.concat(chunks), strippedBytes };
}

function stripPngMetadata(buffer) {
  if (buffer.length < 20) {
    return { buffer, strippedBytes: 0 };
  }

  const STRIP_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
  const chunks = [buffer.subarray(0, 8)]; // 8-byte PNG signature
  let offset = 8;
  let strippedBytes = 0;
  let sawIhdr = false;
  let sawIend = false;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const chunkTotal = 12 + length;
    if (length > 0x7fffffff || offset + chunkTotal > buffer.length) {
      return { buffer, strippedBytes: 0 };
    }

    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IHDR') sawIhdr = true;

    if (STRIP_CHUNKS.has(type)) {
      strippedBytes += chunkTotal;
    } else {
      chunks.push(buffer.subarray(offset, offset + chunkTotal));
    }

    offset += chunkTotal;
    if (type === 'IEND') {
      sawIend = true;
      break;
    }
  }

  if (!sawIhdr || !sawIend || strippedBytes === 0) {
    return { buffer, strippedBytes: 0 };
  }
  return { buffer: Buffer.concat(chunks), strippedBytes };
}

function stripWebpMetadata(buffer) {
  if (buffer.length <= 12) {
    return { buffer, strippedBytes: 0 };
  }

  const chunks = [Buffer.from(buffer.subarray(0, 12))]; // RIFF header
  let offset = 12;
  let strippedBytes = 0;

  while (offset + 8 <= buffer.length) {
    const fourCC = buffer.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const paddedSize = chunkSize + (chunkSize % 2);
    const chunkTotal = 8 + paddedSize;

    if (offset + chunkTotal > buffer.length) {
      return { buffer, strippedBytes: 0 };
    }

    if (fourCC === 'EXIF' || fourCC === 'XMP ') {
      strippedBytes += chunkTotal;
    } else if (fourCC === 'VP8X' && chunkSize >= 4) {
      const vp8xChunk = Buffer.from(buffer.subarray(offset, offset + chunkTotal));
      // 清除 VP8X flags 字节中的 EXIF (0x08) 与 XMP (0x04) 标志位
      vp8xChunk[8] &= ~(0x08 | 0x04);
      chunks.push(vp8xChunk);
    } else {
      chunks.push(buffer.subarray(offset, offset + chunkTotal));
    }

    offset += chunkTotal;
  }

  if (strippedBytes === 0) {
    return { buffer, strippedBytes: 0 };
  }

  const cleaned = Buffer.concat(chunks);
  cleaned.writeUInt32LE(cleaned.length - 8, 4);
  return { buffer: cleaned, strippedBytes };
}

/**
 * 纯 Node.js 零依赖剥离图片隐私元数据（EXIF/GPS/XMP/IPTC/文本注释）
 */
export function stripImageMetadata(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) {
    return { buffer, strippedBytes: 0 };
  }

  const detected = mimeType || detectSafeImageMime(buffer);
  if (detected === 'image/jpeg') return stripJpegMetadata(buffer);
  if (detected === 'image/png') return stripPngMetadata(buffer);
  if (detected === 'image/webp') return stripWebpMetadata(buffer);
  return { buffer, strippedBytes: 0 };
}

/**
 * 阅后即焚内存图片保险箱
 * 图片绝不落盘、绝不自动弹窗；仅在用户或 AI 主动调用 inspect_image 时交付给用户自己的多模态 AI 审核。
 */
export class EphemeralImageVault {
  constructor(maxItems = 20) {
    this.maxItems = maxItems;
    this.items = new Map();
  }

  storeIncoming({ senderId, nickname, base64Data, caption = '' }) {
    const buffer = Buffer.from(String(base64Data || ''), 'base64');
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
      throw new Error(`图片大小非法或超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 上限，已拒绝接收。`);
    }

    const mimeType = detectSafeImageMime(buffer);
    if (!mimeType) {
      throw new Error('仅允许接收合法的 PNG / JPEG / WebP 图片，疑似伪装文件已拦截。');
    }

    const metadataWarnings = inspectBinaryMetadata(buffer);
    const imageId = `img_${crypto.randomBytes(4).toString('hex')}`;

    if (this.items.size >= this.maxItems) {
      const oldestKey = this.items.keys().next().value;
      this.items.delete(oldestKey);
    }

    const safeNickname = sanitizeUntrustedField(nickname || '匿名真人', 32) || '匿名真人';
    const safeCaption = sanitizeUntrustedField(caption || '', 200);

    const record = {
      imageId,
      senderId,
      nickname: safeNickname,
      mimeType,
      sizeBytes: buffer.length,
      caption: safeCaption,
      metadataWarnings,
      base64: buffer.toString('base64'),
      receivedAt: new Date().toISOString(),
    };
    this.items.set(imageId, record);

    return {
      imageId,
      mimeType,
      sizeBytes: buffer.length,
      metadataWarnings,
    };
  }

  get(imageId) {
    return this.items.get(imageId) || null;
  }

  clear() {
    this.items.clear();
  }
}
