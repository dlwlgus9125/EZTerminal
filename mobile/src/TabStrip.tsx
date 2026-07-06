import { useCallback, useEffect, useRef } from 'react';

import { formatCwd } from '../../src/renderer/format-cwd';
import { decideTabSwipe } from './tab-swipe';
import type { Tab } from './tabs';

/** Pills are compact — a much shorter budget than the terminal prompt's 44. */
const PILL_CWD_MAX = 18;

// TabStrip — horizontally scrollable row of open-session pills (M5,
// mobile-parity plan D5). Pure display + activate/close; MobileWorkspace owns
// the actual tab state (tabsReducer) and the `+`/☰/📊/🎨 buttons that sit
// beside this strip in the workspace header. Swipe (touchstart/touchend) is
// handled HERE ONLY — never on the block list, which needs its own vertical
// scroll/drag gestures uncontested. `.tab-strip` is also horizontally
// scrollable (overflow-x: auto) to reveal tabs clipped by a narrow header, so
// touchend also tracks how far the strip itself scrolled and hands that to
// `decideTabSwipe` (v0.2.0 plan D4) to suppress swipe-triggered tab switches
// during a strip scroll.
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
  const stripRef = useRef<HTMLDivElement | null>(null);
  const touchStart = useRef<{ x: number; y: number; scrollLeft: number } | null>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const t = e.touches[0];
    touchStart.current = t
      ? { x: t.clientX, y: t.clientY, scrollLeft: stripRef.current?.scrollLeft ?? 0 }
      : null;
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
      const scrollDelta = (stripRef.current?.scrollLeft ?? start.scrollLeft) - start.scrollLeft;
      const decision = decideTabSwipe({ dx, dy, scrollDelta });
      if (!decision) return;

      const idx = tabs.findIndex((tab) => tab.sessionId === activeSessionId);
      if (idx === -1) return;
      const next = decision === 'next' ? tabs[idx + 1] : tabs[idx - 1];
      if (next) onActivate(next.sessionId);
    },
    [tabs, activeSessionId, onActivate],
  );

  // Keep the active pill visible when it changes out from under the strip
  // (e.g. activated from the ☰ session list rather than a swipe/tap here).
  // Optional-call guards jsdom, which has no scrollIntoView.
  useEffect(() => {
    stripRef.current?.querySelector('.tab-pill--active')?.scrollIntoView?.({
      inline: 'nearest',
      block: 'nearest',
    });
  }, [activeSessionId]);

  return (
    <div
      ref={stripRef}
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
