import { useEffect, useState } from 'react';

/** Stage cards are rem-sized; one card is this many scale-free graph units at 100%. */
export const WORKFLOW_CARD_UNITS = { width: 248, height: 136 } as const;

function read(): number {
  if (typeof document === 'undefined') return 1;
  return (Number(document.documentElement.dataset.uiScale) || 100) / 100;
}
/**
 * The UI scale as a factor (1.3 at 130%). Stored stage positions are scale-free graph units;
 * renderers multiply by this so cards, gaps and edges grow together at any UI scale, and a flow
 * arranged on one device lines up on another.
 */
export function useWorkflowScale(): number {
  const [scale, setScale] = useState(read);
  useEffect(() => {
    const update = () => setScale(read());
    update();
    window.addEventListener('ez:ui-scale', update);
    return () => window.removeEventListener('ez:ui-scale', update);
  }, []);
  return scale;
}
