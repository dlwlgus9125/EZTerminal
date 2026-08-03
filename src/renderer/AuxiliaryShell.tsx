import { useEffect } from 'react';

import { WindowControls } from './workbench/WindowControls';

/**
 * Dockview moves the live panel DOM into this document after its load event.
 * This React root owns only native-window chrome; it never mounts a second App
 * or creates another terminal session.
 */
export function AuxiliaryShell(): JSX.Element {
  useEffect(() => {
    document.documentElement.dataset.ezWindow = 'auxiliary';
    return () => {
      delete document.documentElement.dataset.ezWindow;
    };
  }, []);

  return (
    <main className="auxiliary-shell" data-testid="auxiliary-shell">
      <header className="auxiliary-titlebar">
        <span className="auxiliary-titlebar__mark" aria-hidden="true">EZ</span>
        <span className="auxiliary-titlebar__title">EZTerminal</span>
        <span className="auxiliary-titlebar__drag-space" />
        <WindowControls compact />
      </header>
    </main>
  );
}
