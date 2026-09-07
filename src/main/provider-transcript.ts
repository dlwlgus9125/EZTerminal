/** User-owned conversation content. Diagnostic sanitization belongs at log boundaries. */
export function providerTranscriptText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(providerTranscriptText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    const block = value as Record<string, unknown>;
    if (typeof block.text === 'string') return block.text;
    if (block.content !== undefined) return providerTranscriptText(block.content);
    return JSON.stringify(value, null, 2);
  }
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}
