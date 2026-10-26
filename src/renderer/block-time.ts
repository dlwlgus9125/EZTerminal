/** A block's start as the 24-hour local clock (`14:20`). */
export function formatBlockClock(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** How long a block ran, as an i18n key and its values: tenths under ten seconds, whole seconds under a minute. */
export function blockDuration(ms: number): { readonly key: 'block.durationSeconds'; readonly values: { readonly value: string } }
  | { readonly key: 'block.durationMinutes'; readonly values: { readonly minutes: number; readonly seconds: number } } {
  const safe = Math.max(0, ms);
  if (safe < 10_000) return { key: 'block.durationSeconds', values: { value: (Math.round(safe / 100) / 10).toFixed(1) } };
  if (safe < 60_000) return { key: 'block.durationSeconds', values: { value: String(Math.round(safe / 1000)) } };
  const total = Math.round(safe / 1000);
  return { key: 'block.durationMinutes', values: { minutes: Math.floor(total / 60), seconds: total % 60 } };
}
