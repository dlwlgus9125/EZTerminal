import { useEffect, useState } from 'react';

// usePageVisible — tracks the Page Visibility API (openclaw-stabilization
// M6), used to pause OpenClaw status/log WS subscriptions while the app is
// backgrounded so they stop burning battery on a screen nobody sees. Plain
// `document.visibilitychange` rather than the `@capacitor/app` plugin's own
// state-change event: the latter isn't a dependency of this package (see
// mobile/package.json) and `visibilitychange` already fires reliably in a
// Capacitor WebView when the app is backgrounded/foregrounded.
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');

  useEffect(() => {
    const handler = (): void => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  return visible;
}
