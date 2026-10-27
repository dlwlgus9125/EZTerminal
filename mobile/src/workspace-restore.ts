/** Device-local view identities only; authoritative content stays on the host. */
export interface MobileWorkspaceRestore {
  readonly terminalSessionIds: readonly string[];
  readonly activeTerminalSessionId: string | null;
  readonly activeAgentSessionId: string | null;
  readonly destination: 'terminal' | 'agents';
  /** Where the phone was last (I4). Optional: a record from before the feed has none, and that build ignores it. */
  readonly lastSurface?: 'feed' | 'terminal' | 'chat';
}

const key = (authority: string): string => `ezterminal-workspace-v1:${authority}`;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;

export function readWorkspaceRestore(authority: string): MobileWorkspaceRestore | null {
  try {
    const saved = JSON.parse(localStorage.getItem(key(authority)) ?? 'null');
    if (!saved || !Array.isArray(saved.terminalSessionIds) || saved.terminalSessionIds.length > 128
      || !saved.terminalSessionIds.every(validId)
      || !(saved.activeTerminalSessionId === null || validId(saved.activeTerminalSessionId))
      || !(saved.activeAgentSessionId === null || validId(saved.activeAgentSessionId))
      || !['terminal', 'agents'].includes(saved.destination)) return null;
    const { lastSurface, ...rest } = saved as MobileWorkspaceRestore;
    // An unknown surface (a later build's) is dropped, not the whole record.
    return lastSurface === 'feed' || lastSurface === 'terminal' || lastSurface === 'chat' ? { ...rest, lastSurface } : rest;
  } catch { return null; }
}

export function writeWorkspaceRestore(authority: string, state: MobileWorkspaceRestore): void {
  try { localStorage.setItem(key(authority), JSON.stringify(state)); } catch { /* Optional view restoration. */ }
}
