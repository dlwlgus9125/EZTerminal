export const IMAGE_PREVIEW_MAX_BYTES = 20 * 1_048_576;
export const IMAGE_PREVIEW_MAX_DIMENSION = 16_384;
export const IMAGE_PREVIEW_MAX_PIXELS = 64_000_000;
export const IMAGE_PREVIEW_SNIFF_BYTES = 256 * 1_024;

export type PreviewImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface PreviewImageInfo {
  readonly mime: PreviewImageMime;
  readonly width: number;
  readonly height: number;
}

export type FilePreviewUnsupportedReason =
  | 'binary'
  | 'image-too-large'
  | 'image-dimensions'
  | 'invalid-image';

/** Transport-safe preview classification. The streamed bytes/content are
 * deliberately excluded and reconstructed by the receiving transport. */
export type FilePreviewStreamMetadata =
  | {
      readonly kind: 'text';
      readonly name: string;
      readonly mime: 'text/plain' | 'text/markdown';
    }
  | {
      readonly kind: 'image';
      readonly name: string;
      readonly mime: PreviewImageMime;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: 'pdf';
      readonly name: string;
      readonly mime: 'application/pdf';
    }
  | {
      readonly kind: 'unsupported';
      readonly name: string;
      readonly reason: FilePreviewUnsupportedReason;
    };

export type FilePreviewResult =
  | {
      readonly ok: true;
      readonly kind: 'text';
      readonly name: string;
      readonly mime: 'text/plain' | 'text/markdown';
      readonly content: string;
      readonly truncated: boolean;
      readonly fileSize: number;
    }
  | {
      readonly ok: true;
      readonly kind: 'image';
      readonly name: string;
      readonly mime: PreviewImageMime;
      readonly bytes: Uint8Array;
      readonly width: number;
      readonly height: number;
      readonly fileSize: number;
    }
  | {
      readonly ok: true;
      readonly kind: 'pdf';
      readonly name: string;
      readonly mime: 'application/pdf';
      readonly fileSize: number;
    }
  | {
      readonly ok: true;
      readonly kind: 'unsupported';
      readonly name: string;
      readonly fileSize: number;
      readonly reason: FilePreviewUnsupportedReason;
    }
  | { readonly ok: false; readonly error: string };

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  const end = Math.min(bytes.length, start + length);
  for (let i = start; i < end; i += 1) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

function jpegDimensions(bytes: Uint8Array): PreviewImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset] ?? 0;
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;
    const length = u16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) break;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && length >= 7) {
      const height = u16be(bytes, offset + 3);
      const width = u16be(bytes, offset + 5);
      return width > 0 && height > 0 ? { mime: 'image/jpeg', width, height } : null;
    }
    offset += length;
  }
  return null;
}

/**
 * Parse only the bounded header supplied by FileService. Returning null means
 * either "not a supported raster image" or "recognized but malformed"; the
 * caller distinguishes that case with `looksLikeSupportedImage` below.
 */
export function parsePreviewImageInfo(bytes: Uint8Array): PreviewImageInfo | null {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === 'PNG' &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    const width = u32be(bytes, 16);
    const height = u32be(bytes, 20);
    return width > 0 && height > 0 ? { mime: 'image/png', width, height } : null;
  }

  if (bytes.length >= 10 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) {
    const width = u16le(bytes, 6);
    const height = u16le(bytes, 8);
    return width > 0 && height > 0 ? { mime: 'image/gif', width, height } : null;
  }

  const jpeg = jpegDimensions(bytes);
  if (jpeg) return jpeg;

  if (bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === 'VP8X' && bytes.length >= 30) {
      return {
        mime: 'image/webp',
        width: u24le(bytes, 24) + 1,
        height: u24le(bytes, 27) + 1,
      };
    }
    if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return {
        mime: 'image/webp',
        width: u16le(bytes, 26) & 0x3fff,
        height: u16le(bytes, 28) & 0x3fff,
      };
    }
    if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      const b1 = bytes[21] ?? 0;
      const b2 = bytes[22] ?? 0;
      const b3 = bytes[23] ?? 0;
      const b4 = bytes[24] ?? 0;
      return {
        mime: 'image/webp',
        width: 1 + b1 + ((b2 & 0x3f) << 8),
        height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
      };
    }
  }

  return null;
}

export function looksLikeSupportedImage(bytes: Uint8Array): boolean {
  return (
    (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) ||
    (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') ||
    (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) ||
    (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP')
  );
}

export function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && ascii(bytes, 0, 5) === '%PDF-';
}

export function validatePreviewImage(info: PreviewImageInfo, fileSize: number): FilePreviewUnsupportedReason | null {
  if (fileSize > IMAGE_PREVIEW_MAX_BYTES) return 'image-too-large';
  if (
    info.width > IMAGE_PREVIEW_MAX_DIMENSION ||
    info.height > IMAGE_PREVIEW_MAX_DIMENSION ||
    info.width * info.height > IMAGE_PREVIEW_MAX_PIXELS
  ) {
    return 'image-dimensions';
  }
  return null;
}
