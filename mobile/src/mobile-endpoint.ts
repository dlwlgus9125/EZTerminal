/** Host:port of a `ws(s)://` endpoint, for the shell's connection chips. */
export function formatEndpointHost(url: string): string {
  const authority = url.match(/^wss?:\/\/([^/?#]+)/i)?.[1];
  return authority ?? url;
}

/** `1h 24m` style uptime for the settings connection card. */
export function formatUptime(elapsedMs: number): string {
  const minutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
