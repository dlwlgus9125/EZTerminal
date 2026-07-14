import { describe, expect, it } from 'vitest';

import { EXTERNAL_HTTP_URL_MAX_LENGTH, normalizeExternalHttpUrl } from './external-url';

describe('normalizeExternalHttpUrl', () => {
  it('accepts http and https URLs with a hostname', () => {
    expect(normalizeExternalHttpUrl('https://example.com/a?q=1')).toBe('https://example.com/a?q=1');
    expect(normalizeExternalHttpUrl('http://localhost:8080')).toBe('http://localhost:8080/');
  });

  it('rejects dangerous schemes, credentials, malformed values and oversized input', () => {
    expect(normalizeExternalHttpUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeExternalHttpUrl('file:///tmp/a')).toBeNull();
    expect(normalizeExternalHttpUrl('https://user:pass@example.com')).toBeNull();
    expect(normalizeExternalHttpUrl('not a url')).toBeNull();
    expect(normalizeExternalHttpUrl(`https://example.com/${'a'.repeat(EXTERNAL_HTTP_URL_MAX_LENGTH)}`)).toBeNull();
  });
});
