/**
 * Per-conversation memory for the Results tab: whether it already opened on
 * its own, and whether the person closed it. Only these two flags are kept,
 * on this device; never file contents or paths. A closed tab never opens on
 * its own again for that conversation.
 */
const KEY = 'ezterminal.agent.results-tab.v1';
const LIMIT = 500;

export interface ResultsTabPrefs {
  readonly autoOpened: boolean;
  readonly dismissed: boolean;
}

const EMPTY: ResultsTabPrefs = { autoOpened: false, dismissed: false };

/** Oldest first; the newest write moves to the end. Mirrors storage so a storage failure keeps working. */
let memory: [string, ResultsTabPrefs][] | undefined;

function isPrefs(value: unknown): value is ResultsTabPrefs {
  return typeof value === 'object' && value !== null
    && typeof (value as ResultsTabPrefs).autoOpened === 'boolean'
    && typeof (value as ResultsTabPrefs).dismissed === 'boolean';
}

function load(): [string, ResultsTabPrefs][] {
  if (memory) return memory;
  let entries: [string, ResultsTabPrefs][] = [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (Array.isArray(parsed)) {
      entries = parsed.filter((entry): entry is [string, ResultsTabPrefs] => Array.isArray(entry)
        && typeof entry[0] === 'string' && isPrefs(entry[1]))
        .map(([id, prefs]) => [id, { autoOpened: prefs.autoOpened, dismissed: prefs.dismissed }]);
    }
  } catch { /* An unreadable store starts empty. */ }
  memory = entries.slice(-LIMIT);
  return memory;
}

function save(entries: [string, ResultsTabPrefs][]): void {
  memory = entries.slice(-LIMIT);
  try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* Memory still holds it for this window. */ }
}

export function readResultsTabPrefs(sessionId: string): ResultsTabPrefs {
  return load().find(([id]) => id === sessionId)?.[1] ?? EMPTY;
}

function write(sessionId: string, patch: Partial<ResultsTabPrefs>): void {
  const next = { ...readResultsTabPrefs(sessionId), ...patch };
  save([...load().filter(([id]) => id !== sessionId), [sessionId, next]]);
}

export function markResultsAutoOpened(sessionId: string): void {
  write(sessionId, { autoOpened: true });
}

/** The person closed the tab: it stays closed until they open it again themselves. */
export function markResultsDismissed(sessionId: string): void {
  write(sessionId, { dismissed: true });
}

/** Tests only: forget the in-memory mirror so the next read goes to storage. */
export function resetResultsTabPrefsForTests(): void {
  memory = undefined;
}
