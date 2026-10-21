import { isAccessLevel, type AccessLevel } from './agent-permission-copy';

/**
 * The access level a conversation runs its plan with, remembered while the
 * stored preset is `plan`. It lives on this device only: another device, an
 * older plan session or a cleared store falls back to asking before running,
 * never to full access.
 */
const KEY = 'ezterminal.agent.plan-access.v1';
const LIMIT = 200;
const FALLBACK: AccessLevel = 'standard';

/** Oldest first; the newest write moves to the end. Mirrors storage so a storage failure keeps working. */
let memory: [string, AccessLevel][] | undefined;

function load(): [string, AccessLevel][] {
  if (memory) return memory;
  let entries: [string, AccessLevel][] = [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (Array.isArray(parsed)) {
      entries = parsed.filter((entry): entry is [string, AccessLevel] => Array.isArray(entry)
        && typeof entry[0] === 'string' && isAccessLevel(entry[1]));
    }
  } catch { /* An unreadable store starts empty. */ }
  memory = entries.slice(-LIMIT);
  return memory;
}

function save(entries: [string, AccessLevel][]): void {
  memory = entries.slice(-LIMIT);
  try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* Memory still holds it for this window. */ }
}

export function readPlanAccess(sessionId: string): AccessLevel {
  return load().find(([id]) => id === sessionId)?.[1] ?? FALLBACK;
}

export function writePlanAccess(sessionId: string, level: AccessLevel): void {
  save([...load().filter(([id]) => id !== sessionId), [sessionId, level]]);
}

/**
 * A conversation continued from, or replacing (`/clear`), another one starts its plan with the
 * level chosen there, unless a level was already chosen for it.
 */
export function inheritPlanAccess(fromId: string, toId: string): void {
  const entries = load();
  const source = entries.find(([id]) => id === fromId);
  if (!source || fromId === toId || entries.some(([id]) => id === toId)) return;
  save([...entries, [toId, source[1]]]);
}

const LAST_KEY = 'ezterminal.agent.last-access.v1';
let lastMemory: AccessLevel | null | undefined;

/** The access level the person last chose on this device; new conversations start with it. */
export function readLastAccess(): AccessLevel | undefined {
  if (lastMemory === undefined) {
    try {
      const stored = localStorage.getItem(LAST_KEY);
      lastMemory = isAccessLevel(stored) ? stored : null;
    } catch { lastMemory = null; }
  }
  return lastMemory ?? undefined;
}

export function writeLastAccess(level: AccessLevel): void {
  lastMemory = level;
  try { localStorage.setItem(LAST_KEY, level); } catch { /* Memory still holds it for this window. */ }
}

/** A draft or a start panel becomes a real session: its choice follows. */
export function movePlanAccess(fromId: string, toId: string): void {
  const entry = load().find(([id]) => id === fromId);
  if (!entry || fromId === toId) return;
  save([...load().filter(([id]) => id !== fromId && id !== toId), [toId, entry[1]]]);
}

/** Tests only: forget the in-memory mirror so the next read goes to storage. */
export function resetPlanAccessForTests(): void {
  memory = undefined;
  lastMemory = undefined;
}
