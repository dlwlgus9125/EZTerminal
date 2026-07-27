import { useEffect, useState } from 'react';

/**
 * Tracks `prefers-reduced-motion: reduce`.
 *
 * The CSS side of this preference is already handled by the motion tokens
 * collapsing to 0ms, so components only need this hook when the decision is
 * structural rather than visual — skipping a sequence outright, or telling the
 * user that the system has paused something they asked for.
 *
 * `addListener`/`removeListener` are kept as a fallback because the same
 * renderer code runs inside the Android WebView, where the modern
 * `addEventListener` form is not available on older runtimes.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (): void => setReduced(media.matches);
    onChange();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    }
    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }, []);

  return reduced;
}
