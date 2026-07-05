import { useCallback, useRef } from 'react';

import { formatCwd } from '../../src/renderer/format-cwd';
import type { Tab } from './tabs';

const SWIPE_MIN_DX = 60;
const SWIPE_MAX_DY = 40;
/** Pills are compact — a much shorter budget than the terminal prompt's 44. */
const PILL_CWD_MAX = 18;

// TabStrip — horizontally scrollable row of open-session pills (M5,
// mobile-parity plan D5). Pure display + activate/close; MobileWorkspace owns
// the actual tab state (tabsReducer) and the `+`/☰/📊/🎨 buttons that sit
// beside this strip in the workspace header. Swipe (touchstart/touchend) is
// handled HERE ONLY — never on the block list, which needs its own vertical
// scroll/drag gestures uncontested.
export function TabStrip({
  tabs,
  activeSessionId,
  onActivate,
  onClose,
}: {
  tabs: readonly Tab[];
  activeSessionId: string | null;
  onActivate: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
}): JSX.Element {
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const t = e.touches[0];
    touchStart.current = t ? { x: t.clientX, y: t.clientY } : null;
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const start = touchStart.current;
      touchStart.current = null;
      if (!start) return;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (Math.abs(dx) <= SWIPE_MIN_DX || Math.abs(dy) >= SWIPE_MAX_DY) return;

      const idx = tabs.findIndex((tab) => tab.sessionId === activeSessionId);
      if (idx === -1) return;
      // Swipe left (dx<0, finger moving toward the start) advances to the
      // next tab; swipe right goes back to the previous one.
      const next = dx < 0 ? tabs[idx + 1] : tabs[idx - 1];
      if (next) onActivate(next.sessionId);
    },
    [tabs, activeSessionId, onActivate],
  );

  return (
    <div
      className="tab-strip"
      data-testid="tab-strip"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {tabs.map((tab) => (
        <div
          key={tab.sessionId}
          className={tab.sessionId === activeSessionId ? 'tab-pill tab-pill--active' : 'tab-pill'}
          data-testid="tab-pill"
        >
          <button
            type="button"
            className="tab-pill-label"
            onClick={() => onActivate(tab.sessionId)}
            title={tab.cwd}
            data-testid="tab-pill-open"
          >
            {formatCwd(tab.cwd, PILL_CWD_MAX)}
          </button>
          <button
            type="button"
            className="tab-pill-close"
            onClick={() => onClose(tab.sessionId)}
            aria-label="Close tab"
            data-testid="tab-pill-close"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
