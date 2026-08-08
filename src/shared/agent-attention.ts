import type { AgentActivitySnapshot, AgentStatus } from './agent';

const ATTENTION_STATUSES = new Set<AgentStatus>(['blocked', 'error', 'waiting']);

export function countAgentAttention(snapshot: AgentActivitySnapshot): number {
  return snapshot.items.filter((item) => ATTENTION_STATUSES.has(item.status)).length;
}
