import type { DaemonEvent } from '../shared/daemon-protocol';

const PROJECTION_ENTITY_TYPES = new Set([
  'project',
  'workspace',
  'session',
  'agent',
  'relation',
  'provider',
]);

/** Events whose payload can change the Project → Workspace → Session list. */
export function daemonEventAffectsAgentSessionProjection(event: DaemonEvent): boolean {
  if (event.kind === 'entity.upserted') {
    return PROJECTION_ENTITY_TYPES.has(event.payload.entityType);
  }
  return event.kind === 'entity.archived' || event.kind === 'runtime.recovery';
}
