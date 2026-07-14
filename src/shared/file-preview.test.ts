import { describe, expect, it } from 'vitest';

import {
  IMAGE_PREVIEW_MAX_BYTES,
  looksLikePdf,
  looksLikeSupportedImage,
  parsePreviewImageInfo,
  validatePreviewImage,
} from './file-preview';

describe('file preview signatures', () => {
  it('parses PNG dimensions from the IHDR header', () => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    bytes.set([0, 0, 0, 80, 0, 0, 0, 40], 16);
    expect(parsePreviewImageInfo(bytes)).toEqual({ mime: 'image/png', width: 80, height: 40 });
  });

  it('parses GIF and JPEG dimensions', () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0, 0x10, 0]);
    expect(parsePreviewImageInfo(gif)).toEqual({ mime: 'image/gif', width: 32, height: 16 });

    const jpeg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc0, 0, 17, 8, 0, 48, 0, 64, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
      0xff, 0xd9,
    ]);
    expect(parsePreviewImageInfo(jpeg)).toEqual({ mime: 'image/jpeg', width: 64, height: 48 });
  });

  it('parses WebP VP8X dimensions', () => {
    const bytes = new Uint8Array(30);
    bytes.set(new TextEncoder().encode('RIFF'), 0);
    bytes.set(new TextEncoder().encode('WEBPVP8X'), 8);
    bytes.set([0x7f, 0, 0, 0x3f, 0, 0], 24);
    expect(parsePreviewImageInfo(bytes)).toEqual({ mime: 'image/webp', width: 128, height: 64 });
  });

  it('recognizes malformed supported images separately from arbitrary binary', () => {
    expect(looksLikeSupportedImage(new Uint8Array([0xff, 0xd8, 0, 0]))).toBe(true);
    expect(parsePreviewImageInfo(new Uint8Array([0xff, 0xd8, 0, 0]))).toBeNull();
    expect(looksLikeSupportedImage(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('recognizes PDF magic and enforces image limits', () => {
    expect(looksLikePdf(new TextEncoder().encode('%PDF-1.7'))).toBe(true);
    expect(validatePreviewImage({ mime: 'image/png', width: 100, height: 100 }, IMAGE_PREVIEW_MAX_BYTES + 1))
      .toBe('image-too-large');
    expect(validatePreviewImage({ mime: 'image/png', width: 20_000, height: 10 }, 100))
      .toBe('image-dimensions');
    expect(validatePreviewImage({ mime: 'image/png', width: 800, height: 600 }, 100))
      .toBeNull();
  });
});
