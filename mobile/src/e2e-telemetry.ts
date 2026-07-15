/** Android UI-automation probes, compiled out of normal production builds. */
export const E2E_TELEMETRY_ENABLED = (
  typeof __EZTERMINAL_E2E__ !== 'undefined' && __EZTERMINAL_E2E__
);

function serializeE2EDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  try {
    return JSON.stringify(detail) ?? String(detail);
  } catch {
    return String(detail);
  }
}

export function e2eLog(marker: string, ...details: readonly unknown[]): void {
  if (!E2E_TELEMETRY_ENABLED) return;
  // WebView 74's Android console bridge keeps only the first console argument.
  // Emit one newline-safe string so every supported API level exposes the
  // same marker payload to logcat.
  const suffix = details.map(serializeE2EDetail).join(' ');
  console.log(`[ez-e2e] ${marker}${suffix ? ` ${suffix}` : ''}`);
}

export function installE2ETerminalOutputProbe(container: ParentNode | null): () => void {
  if (!E2E_TELEMETRY_ENABLED || !container) return () => undefined;

  const observer = new MutationObserver(() => {
    for (const element of container.querySelectorAll('[data-testid="text-output"]')) {
      const output = element.textContent;
      if (output) e2eLog('output:', output);
    }
  });
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}
