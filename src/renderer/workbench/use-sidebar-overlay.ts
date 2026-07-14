import { useEffect, useState } from 'react';

export const SIDEBAR_REFLOW_QUERY = '(min-width: 1200px)';

function readReflow(query: string): boolean {
  return typeof window !== 'undefined' && window.matchMedia(query).matches;
}

/**
 * Returns true when the workbench sidebar participates in layout reflow.
 * Keeping this decision in one hook prevents the visual breakpoint and the
 * OpenClaw WebContentsView occlusion model from drifting apart.
 */
export function useSidebarReflow(query = SIDEBAR_REFLOW_QUERY): boolean {
  const [reflow, setReflow] = useState(() => readReflow(query));

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = (): void => setReflow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return reflow;
}
