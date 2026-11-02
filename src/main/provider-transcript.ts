/** What a row says for an image. One screenshot is about a megabyte of base64: it travels to phones with every row. */
const IMAGE_MARK = '[image]';
const IMAGE_BLOCK_TYPES = new Set(['image', 'input_image', 'inputImage', 'localImage']);
const IMAGE_DATA_URL = /^data:image\/[\w.+-]+;base64,[\w+/=-]+$/iu;

function isImageBlock(value: object): boolean {
  const type = (value as Record<string, unknown>).type;
  return typeof type === 'string' && IMAGE_BLOCK_TYPES.has(type);
}

/** For a shape nothing reads: the image goes, wherever it sits. */
function withoutImages(_key: string, value: unknown): unknown {
  if (typeof value === 'string') return IMAGE_DATA_URL.test(value) ? IMAGE_MARK : value;
  return value && typeof value === 'object' && isImageBlock(value) ? IMAGE_MARK : value;
}

/** User-owned conversation content. Diagnostic sanitization belongs at log boundaries. Image bytes never reach a row. */
export function providerTranscriptText(value: unknown): string {
  if (typeof value === 'string') return IMAGE_DATA_URL.test(value) ? IMAGE_MARK : value;
  if (Array.isArray(value)) return value.map(providerTranscriptText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    if (isImageBlock(value)) return IMAGE_MARK;
    const block = value as Record<string, unknown>;
    if (typeof block.text === 'string') return block.text;
    if (block.content !== undefined) return providerTranscriptText(block.content);
    return JSON.stringify(value, withoutImages, 2);
  }
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}
