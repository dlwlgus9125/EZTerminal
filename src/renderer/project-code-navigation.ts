export interface ProjectCodeTarget {
  readonly projectId: string;
  readonly rootId: string;
  readonly relativePath: string;
}

export interface ProjectCodeLocation {
  readonly line: number;
  readonly column?: number;
}

interface PendingLocation {
  readonly location: ProjectCodeLocation;
  readonly createdAt: number;
}

const MAX_PENDING_LOCATIONS = 64;
const LOCATION_TTL_MS = 60_000;
const pending = new Map<string, PendingLocation>();
const listeners = new Map<string, Set<(location: ProjectCodeLocation) => void>>();

function targetKey(target: ProjectCodeTarget): string {
  return `${target.projectId}\0${target.rootId}\0${target.relativePath}`;
}

function boundedLocation(location: ProjectCodeLocation): ProjectCodeLocation | null {
  if (!Number.isInteger(location.line) || location.line < 1 || location.line > 10_000_000) return null;
  if (location.column !== undefined
    && (!Number.isInteger(location.column) || location.column < 1 || location.column > 10_000_000)) {
    return null;
  }
  return location;
}

export function requestProjectCodeReveal(
  target: ProjectCodeTarget,
  location: ProjectCodeLocation | undefined,
): void {
  if (!location) return;
  const bounded = boundedLocation(location);
  if (!bounded) return;
  const key = targetKey(target);
  const subscribers = listeners.get(key);
  if (subscribers?.size) {
    for (const listener of subscribers) listener(bounded);
    return;
  }
  pending.delete(key);
  pending.set(key, { location: bounded, createdAt: Date.now() });
  while (pending.size > MAX_PENDING_LOCATIONS) {
    const oldest = pending.keys().next().value as string | undefined;
    if (!oldest) break;
    pending.delete(oldest);
  }
}

export function subscribeProjectCodeReveal(
  target: ProjectCodeTarget,
  listener: (location: ProjectCodeLocation) => void,
): () => void {
  const key = targetKey(target);
  const group = listeners.get(key) ?? new Set<(location: ProjectCodeLocation) => void>();
  group.add(listener);
  listeners.set(key, group);
  const queued = pending.get(key);
  pending.delete(key);
  if (queued && Date.now() - queued.createdAt <= LOCATION_TTL_MS) listener(queued.location);
  return () => {
    group.delete(listener);
    if (group.size === 0) listeners.delete(key);
  };
}
