/** Device-local view identities only; authoritative content stays on the host. */
export interface MobileWorkspaceRestore {
  readonly terminalSessionIds: readonly string[];
  readonly activeTerminalSessionId: string | null;
  readonly activeAgentSessionId: string | null;
  readonly destination: 'terminal' | 'agents';
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
    return saved as MobileWorkspaceRestore;
  } catch { return null; }
}

export function writeWorkspaceRestore(authority: string, state: MobileWorkspaceRestore): void {
  try { localStorage.setItem(key(authority), JSON.stringify(state)); } catch { /* Optional view restoration. */ }
}
