import type { OpenClawMode } from '../shared/layout-schema';

/**
 * Resolve the persisted tri-state OpenClaw preference without coupling the
 * policy to Electron or an OpenClawService instance.
 */
export async function resolveOpenClawVisibility(
  mode: OpenClawMode,
  isInstalled: () => Promise<boolean>,
): Promise<boolean> {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return isInstalled();
}
