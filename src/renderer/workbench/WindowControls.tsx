import { Glyph } from '../ui/Glyph';
import { useEffect, useState } from 'react';

import type { DesktopWindowState } from '../../shared/desktop-window';

const DEFAULT_STATE: DesktopWindowState = {
  windowName: 'main',
  kind: 'main',
  focused: true,
  visible: true,
  minimized: false,
  maximized: false,
  fullscreen: false,
  displayId: 'unknown',
  scaleFactor: 1,
  sequence: 0,
};

export function WindowControls({
  compact = false,
}: {
  readonly compact?: boolean;
}): JSX.Element | null {
  const desktop = window.ezterminalDesktop;
  const supported = (
    typeof desktop?.getWindowState === 'function'
    && typeof desktop.performWindowAction === 'function'
    && typeof desktop.onWindowStateChanged === 'function'
  );
  const [state, setState] = useState(DEFAULT_STATE);

  useEffect(() => {
    if (!desktop || !supported) return;
    let alive = true;
    void desktop.getWindowState()
      .then((next) => {
        if (alive && next) setState(next);
      })
      .catch(() => undefined);
    const unsubscribe = desktop.onWindowStateChanged((next) => setState(next));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [desktop, supported]);

  if (!desktop || !supported) return null;
  const maximized = state.maximized || state.fullscreen;
  return (
    <div
      className={compact ? 'window-controls window-controls--compact' : 'window-controls'}
      data-testid="window-controls"
    >
      <button
        type="button"
        className="window-control"
        aria-label="Minimize window"
        title="Minimize"
        onClick={() => void desktop.performWindowAction('minimize')}
        data-testid="window-minimize"
      >
        <Glyph name="minus" />
      </button>
      <button
        type="button"
        className="window-control"
        aria-label={maximized ? 'Restore window' : 'Maximize window'}
        title={maximized ? 'Restore' : 'Maximize'}
        onClick={() => void desktop.performWindowAction('toggle-maximize')}
        data-testid="window-maximize"
      >
        {maximized ? <Glyph name="copy" /> : <Glyph name="expand" />}
      </button>
      <button
        type="button"
        className="window-control window-control--close"
        aria-label="Close window"
        title="Close"
        onClick={() => void desktop.performWindowAction('close')}
        data-testid="window-close"
      >
        <Glyph name="x" />
      </button>
    </div>
  );
}
