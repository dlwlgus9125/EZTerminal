import type { IDockviewHeaderActionsProps } from 'dockview';
import { useEffect, useState } from 'react';

import { formatCwd } from './format-cwd';
import { getPaneCwd } from './pane-registry';

/** How often the header re-reads the active pane's directory. The registry is a
 * plain store with no change events, and a shell can `cd` at any moment, so the
 * header polls slowly rather than pretending the value is push-based. */
const CWD_POLL_MS = 1500;

/**
 * Trailing slot of a pane group's header: where the active pane is, and how long
 * it has been open.
 *
 * The tab strip can hold several tabs, so per-tab metadata would crowd it and
 * repeat itself. This renders once per group and always describes the active
 * pane, which is the one the titlebar is talking about.
 */
export function PaneHeaderMeta({ activePanel, isGroupActive }: IDockviewHeaderActionsProps): JSX.Element | null {
  const panelId = activePanel?.id ?? null;
  const [cwd, setCwd] = useState<string | null>(null);

  useEffect(() => {
    if (!panelId) {
      setCwd(null);
      return;
    }
    const read = (): void => setCwd(getPaneCwd(panelId) ?? null);
    read();
    const timer = window.setInterval(read, CWD_POLL_MS);
    return () => window.clearInterval(timer);
  }, [panelId]);

  if (!cwd) return null;

  return (
    <div className="pane-header-meta" data-active={isGroupActive ? 'true' : undefined}>
      <span className="pane-header-meta__cwd" title={cwd} data-testid="pane-header-cwd">
        {formatCwd(cwd)}
      </span>
    </div>
  );
}
