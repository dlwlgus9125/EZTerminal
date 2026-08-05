import type { IDockviewHeaderActionsProps } from 'dockview';
import { useEffect, useState } from 'react';

import { formatCwd } from './format-cwd';
import {
  getPaneCwd,
  getPaneOpenedAt,
  subscribePaneRegistry,
} from './pane-registry';

/** Fallback cadence for external cwd changes that have not reached the pane
 * registry yet. Registry-backed pane changes update the header synchronously. */
const CWD_POLL_MS = 1500;

/**
 * Trailing slot of a pane group's header: where the active pane is, and how long
 * it has been open.
 *
 * The tab strip can hold several tabs, so per-tab metadata would crowd it and
 * repeat itself. This renders once per group and always describes the active
 * pane, which is the one the titlebar is talking about.
 */
/** Coarse on purpose. A titlebar clock ticking every second next to a terminal
 * is movement in the corner of the eye that carries no new information, so this
 * changes at most once a minute and is never announced. */
function openForLabel(openedAt: number, now: number): string | null {
  const minutes = Math.floor(Math.max(0, now - openedAt) / 60_000);
  if (minutes < 1) return null;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d`;
}

export function PaneHeaderMeta({ activePanel, isGroupActive }: IDockviewHeaderActionsProps): JSX.Element | null {
  const panelId = activePanel?.id ?? null;
  const [cwd, setCwd] = useState<string | null>(null);
  const [openLabel, setOpenLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!panelId) {
      setCwd(null);
      setOpenLabel(null);
      return;
    }
    const read = (): void => {
      setCwd(getPaneCwd(panelId) ?? null);
      const openedAt = getPaneOpenedAt(panelId);
      setOpenLabel(openedAt === undefined ? null : openForLabel(openedAt, Date.now()));
    };
    read();
    const unsubscribe = subscribePaneRegistry(read);
    const timer = window.setInterval(read, CWD_POLL_MS);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [panelId]);

  if (!cwd) return null;

  return (
    <div className="pane-header-meta" data-active={isGroupActive ? 'true' : undefined}>
      <span className="pane-header-meta__cwd" title={cwd} data-testid="pane-header-cwd">
        {formatCwd(cwd)}
      </span>
      {openLabel && (
        <span className="pane-header-meta__age" data-testid="pane-header-age">{openLabel}</span>
      )}
    </div>
  );
}
