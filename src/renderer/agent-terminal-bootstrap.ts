import type { AgentLaunchBootstrap } from '../shared/agent-history';

interface BootstrapRecord {
  readonly bootstrap: AgentLaunchBootstrap;
  readonly expires: ReturnType<typeof setTimeout>;
}

const records = new Map<string, BootstrapRecord>();
const BOOTSTRAP_TTL_MS = 5 * 60 * 1_000;

/**
 * Runtime-only launch handoff. Dockview layout params must never contain an
 * auto-start instruction, because restoring a layout must not launch an Agent.
 */
export function registerAgentTerminalBootstrap(
  panelId: string,
  bootstrap: AgentLaunchBootstrap,
): void {
  clearAgentTerminalBootstrap(panelId);
  const expires = setTimeout(() => records.delete(panelId), BOOTSTRAP_TTL_MS);
  records.set(panelId, { bootstrap, expires });
}

export function peekAgentTerminalBootstrap(
  panelId: string,
): AgentLaunchBootstrap | undefined {
  return records.get(panelId)?.bootstrap;
}

export function clearAgentTerminalBootstrap(panelId: string): void {
  const record = records.get(panelId);
  if (record) clearTimeout(record.expires);
  records.delete(panelId);
}
