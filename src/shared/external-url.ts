export const EXTERNAL_HTTP_URL_MAX_LENGTH = 8192;

/** Renderer and main both call this; main remains the final authority. */
export function normalizeExternalHttpUrl(value: string): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > EXTERNAL_HTTP_URL_MAX_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname || url.username || url.password) return null;
  return url.href;
}
