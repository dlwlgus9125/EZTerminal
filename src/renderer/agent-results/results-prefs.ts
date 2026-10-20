/**
 * Per-conversation memory for the Results tab: whether the person closed it.
 * Only that flag is kept, on this device; never file contents or paths. A
 * closed tab never opens on its own again for that conversation (the person
 * can still open it). Closing the conversation tab is not closing Results.
 */
const KEY = 'ezterminal.agent.results-tab.v1';
const LIMIT = 500;

export interface ResultsTabPrefs {
  readonly dismissed: boolean;
}

const EMPTY: ResultsTabPrefs = { dismissed: false };

/** Oldest first; the newest write moves to the end. Mirrors storage so a storage failure keeps working. */
let memory: [string, ResultsTabPrefs][] | undefined;

function load(): [string, ResultsTabPrefs][] {
  if (memory) return memory;
  let entries: [string, ResultsTabPrefs][] = [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (Array.isArray(parsed)) {
      entries = parsed.filter((entry): entry is [string, ResultsTabPrefs] => Array.isArray(entry)
        && typeof entry[0] === 'string' && typeof entry[1] === 'object' && entry[1] !== null
        && typeof (entry[1] as ResultsTabPrefs).dismissed === 'boolean')
        .map(([id, prefs]) => [id, { dismissed: prefs.dismissed }]);
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

/** The person closed the tab: it stays closed until they open it again themselves. */
export function markResultsDismissed(sessionId: string): void {
  save([...load().filter(([id]) => id !== sessionId), [sessionId, { dismissed: true }]]);
}

/** Tests only: forget the in-memory mirror so the next read goes to storage. */
export function resetResultsTabPrefsForTests(): void {
  memory = undefined;
}
