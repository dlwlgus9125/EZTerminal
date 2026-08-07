export interface ProjectCodeTarget {
  readonly projectId: string;
  readonly rootId: string;
  readonly workspaceId?: string;
  readonly relativePath: string;
}

export interface ProjectCodeLocation {
  readonly line: number;
  readonly column?: number;
}

interface PendingLocation {
  readonly token: number;
  readonly location: ProjectCodeLocation;
  readonly createdAt: number;
}

interface PendingFocus {
  readonly token: number;
  readonly createdAt: number;
}

const MAX_PENDING_LOCATIONS = 64;
const LOCATION_TTL_MS = 60_000;
const pending = new Map<string, PendingLocation>();
const listeners = new Map<string, Set<(location: ProjectCodeLocation) => boolean>>();
const pendingFocus = new Map<string, PendingFocus>();
const focusListeners = new Map<string, Set<() => boolean>>();
let locationToken = 0;
let focusToken = 0;

function targetKey(target: ProjectCodeTarget): string {
  return `${target.projectId}\0${target.rootId}\0${target.workspaceId ?? target.rootId}\0${target.relativePath}`;
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
  locationToken += 1;
  const request = { token: locationToken, location: bounded, createdAt: Date.now() };
  pending.delete(key);
  pending.set(key, request);
  const subscribers = listeners.get(key);
  if (subscribers?.size) {
    for (const listener of subscribers) {
      if (listener(bounded)) {
        if (pending.get(key)?.token === request.token) pending.delete(key);
        break;
      }
    }
  }
  while (pending.size > MAX_PENDING_LOCATIONS) {
    const oldest = pending.keys().next().value as string | undefined;
    if (!oldest) break;
    pending.delete(oldest);
  }
}

export function subscribeProjectCodeReveal(
  target: ProjectCodeTarget,
  listener: (location: ProjectCodeLocation) => boolean,
): () => void {
  const key = targetKey(target);
  const group = listeners.get(key) ?? new Set<(location: ProjectCodeLocation) => boolean>();
  group.add(listener);
  listeners.set(key, group);
  const queued = pending.get(key);
  if (queued && Date.now() - queued.createdAt <= LOCATION_TTL_MS && listener(queued.location)) {
    if (pending.get(key)?.token === queued.token) pending.delete(key);
  } else if (queued && Date.now() - queued.createdAt > LOCATION_TTL_MS) {
    pending.delete(key);
  }
  return () => {
    group.delete(listener);
    if (group.size === 0) listeners.delete(key);
  };
}

/** Retries the newest unacknowledged reveal after Monaco has attached its
 * model. A request is removed only when a subscriber confirms it applied the
 * location, so renderer timing cannot consume a reveal early. */
export function flushProjectCodeReveal(target: ProjectCodeTarget): void {
  const key = targetKey(target);
  const queued = pending.get(key);
  if (!queued) return;
  if (Date.now() - queued.createdAt > LOCATION_TTL_MS) {
    pending.delete(key);
    return;
  }
  for (const listener of listeners.get(key) ?? []) {
    if (listener(queued.location)) {
      if (pending.get(key)?.token === queued.token) pending.delete(key);
      break;
    }
  }
}

/** Requests DOM focus for a canonical project document. The request remains
 * pending until the mounted editor confirms that focus reached its surface. */
export function requestProjectCodeFocus(target: ProjectCodeTarget): void {
  const key = targetKey(target);
  focusToken += 1;
  const request = { token: focusToken, createdAt: Date.now() };
  pendingFocus.delete(key);
  pendingFocus.set(key, request);
  for (const listener of focusListeners.get(key) ?? []) {
    if (listener()) {
      if (pendingFocus.get(key)?.token === request.token) pendingFocus.delete(key);
      break;
    }
  }
  while (pendingFocus.size > MAX_PENDING_LOCATIONS) {
    const oldest = pendingFocus.keys().next().value as string | undefined;
    if (!oldest) break;
    pendingFocus.delete(oldest);
  }
}

export function subscribeProjectCodeFocus(
  target: ProjectCodeTarget,
  listener: () => boolean,
): () => void {
  const key = targetKey(target);
  const group = focusListeners.get(key) ?? new Set<() => boolean>();
  group.add(listener);
  focusListeners.set(key, group);
  const queued = pendingFocus.get(key);
  if (queued && Date.now() - queued.createdAt <= LOCATION_TTL_MS && listener()) {
    if (pendingFocus.get(key)?.token === queued.token) pendingFocus.delete(key);
  } else if (queued && Date.now() - queued.createdAt > LOCATION_TTL_MS) {
    pendingFocus.delete(key);
  }
  return () => {
    group.delete(listener);
    if (group.size === 0) focusListeners.delete(key);
  };
}

/** Retries focus after the sidebar has closed or Monaco has attached. */
export function flushProjectCodeFocus(target: ProjectCodeTarget): void {
  const key = targetKey(target);
  const queued = pendingFocus.get(key);
  if (!queued) return;
  if (Date.now() - queued.createdAt > LOCATION_TTL_MS) {
    pendingFocus.delete(key);
    return;
  }
  for (const listener of focusListeners.get(key) ?? []) {
    if (listener()) {
      if (pendingFocus.get(key)?.token === queued.token) pendingFocus.delete(key);
      break;
    }
  }
}
