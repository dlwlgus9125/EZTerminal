import { describe, expect, it } from 'vitest';

import { providerTranscriptText } from './provider-transcript';

/** Long enough that any leak of it is plain in a failure, and a stand-in for what a screenshot weighs. */
const BYTES = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'.repeat(40);
const DATA_URL = `data:image/jpeg;base64,${BYTES}`;

describe('providerTranscriptText: image bytes never reach a row', () => {
  it.each([
    ['an MCP image block', { type: 'image', data: BYTES, mimeType: 'image/jpeg' }],
    ['an Anthropic image block', { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: BYTES } }],
    ['a Codex image input', { type: 'image', url: DATA_URL }],
    ['a Responses input_image', { type: 'input_image', image_url: DATA_URL }],
    ['a Codex local image', { type: 'localImage', path: 'C:\\shot.png', data: BYTES }],
  ])('%s is the word [image]', (_name, block) => {
    expect(providerTranscriptText(block)).toBe('[image]');
  });

  it('keeps the text beside an image, as an MCP result arrives from Codex', () => {
    const result = { content: [{ type: 'text', text: 'Screenshot of the preview pane' }, { type: 'image', data: BYTES, mimeType: 'image/jpeg' }], structuredContent: null };
    expect(providerTranscriptText(result)).toBe('Screenshot of the preview pane\n[image]');
  });

  it('keeps the text beside an image in a Claude tool result', () => {
    expect(providerTranscriptText([{ type: 'text', text: 'shot' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BYTES } }])).toBe('shot\n[image]');
  });

  it('marks an image nested in a shape it has no reader for', () => {
    const text = providerTranscriptText({ type: 'customToolCallOutput', output: [{ type: 'input_text', text: 'ran' }, { type: 'input_image', image_url: DATA_URL }] });
    expect(text).toContain('[image]');
    expect(text).toContain('ran');
    expect(text).not.toContain(BYTES);
  });

  it('marks an image data URL that arrives as plain text or a plain field', () => {
    expect(providerTranscriptText(DATA_URL)).toBe('[image]');
    expect(providerTranscriptText({ thumbnail: DATA_URL, name: 'cart' })).not.toContain(BYTES);
  });

  it('leaves everything else as it was', () => {
    expect(providerTranscriptText('plain')).toBe('plain');
    expect(providerTranscriptText(['a', 'b'])).toBe('a\nb');
    expect(providerTranscriptText({ text: 'body' })).toBe('body');
    expect(providerTranscriptText({ content: 'body' })).toBe('body');
    expect(providerTranscriptText({ q: 'bug' })).toBe('{\n  "q": "bug"\n}');
    expect(providerTranscriptText(7)).toBe('7');
    expect(providerTranscriptText(null)).toBe('');
    // An application's own `image` field, or a page that merely mentions data URLs, is not an image block.
    expect(providerTranscriptText({ image: 'cart.png' })).toContain('cart.png');
    expect(providerTranscriptText('see data:image/png;base64 in the docs')).toBe('see data:image/png;base64 in the docs');
  });
});
