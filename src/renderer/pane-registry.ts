// pane-registry — a tiny module-level registry outside React state. dockview
// panel params can't carry a live cwd, so App needs a way to look up the
// active pane's current cwd when opening the file-explorer drawer (M1); M2's
// "paste path into terminal input" action needs the reverse — a way to reach
// into a specific pane's live command input — hence the second map declared
// here now even though only M2 wires it up.

const paneCwds = new Map<string, string>();

export function setPaneCwd(panelId: string, cwd: string): void {
  paneCwds.set(panelId, cwd);
}

export function getPaneCwd(panelId: string): string | undefined {
  return paneCwds.get(panelId);
}

export function removePaneCwd(panelId: string): void {
  paneCwds.delete(panelId);
}

const paneInputs = new Map<string, (text: string) => void>();

export function registerPaneInput(panelId: string, fn: (text: string) => void): void {
  paneInputs.set(panelId, fn);
}

export function unregisterPaneInput(panelId: string): void {
  paneInputs.delete(panelId);
}

/** Returns false when no pane is registered under `panelId` (nothing delivered). */
export function insertIntoPaneInput(panelId: string, text: string): boolean {
  const fn = paneInputs.get(panelId);
  if (!fn) return false;
  fn(text);
  return true;
}
