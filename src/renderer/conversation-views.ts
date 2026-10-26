/**
 * Device-local record of when this person last looked at each conversation,
 * so the terminal can send to "the last conversation I was in". Separate from
 * the inbox's seen marks, which an explicit "mark as read" also writes.
 */

export const CONVERSATION_VIEWS_KEY = 'ezterminal:conversation-viewed:v1';
const INBOX_SEEN_KEY = 'ezterminal:app-chat-inbox:v1';
export const MAX_CONVERSATION_VIEWS = 500;
const REWRITE_AFTER_MS = 5_000;

/** sessionId → ISO time last viewed. */
export type ConversationViews = Readonly<Record<string, string>>;

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

interface ViewRecord {
  readonly sessions: Record<string, string>;
  /** The conversation marked last: marking it again soon after is skipped, marking another never is. */
  readonly last?: string;
}

function defaultStorage(): Storage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}

function parse(raw: string | null): ViewRecord | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as { sessions?: unknown; last?: unknown } | null;
    const sessions = value?.sessions;
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return undefined;
    return {
      sessions: Object.fromEntries(Object.entries(sessions as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !Number.isNaN(Date.parse(entry[1])))),
      ...(typeof value?.last === 'string' ? { last: value.last } : {}),
    };
  } catch {
    return undefined;
  }
}

function write(storage: Storage | undefined, record: ViewRecord): ViewRecord {
  const sessions = Object.fromEntries(Object.entries(record.sessions)
    .sort((left, right) => right[1].localeCompare(left[1]))
    .slice(0, MAX_CONVERSATION_VIEWS));
  const kept: ViewRecord = { sessions, ...(record.last ? { last: record.last } : {}) };
  try { storage?.setItem(CONVERSATION_VIEWS_KEY, JSON.stringify(kept)); } catch { /* Kept for this call only. */ }
  return kept;
}

function readRecord(storage: Storage | undefined): ViewRecord {
  const stored = parse(storage?.getItem(CONVERSATION_VIEWS_KEY) ?? null);
  if (stored) return stored;
  return write(storage, { sessions: parse(storage?.getItem(INBOX_SEEN_KEY) ?? null)?.sessions ?? {} });
}

/** Views so far; the first read starts from the inbox's marks so an upgrade is not empty. */
export function readConversationViews(storage: Storage | undefined = defaultStorage()): ConversationViews {
  return readRecord(storage).sessions;
}

/**
 * Mark a conversation as looked at now. Switching to another conversation is
 * always recorded; marking the same one again within a few seconds is skipped.
 */
export function noteConversationViewed(
  sessionId: string,
  at: Date = new Date(),
  storage: Storage | undefined = defaultStorage(),
): ConversationViews {
  const record = readRecord(storage);
  const previous = record.sessions[sessionId];
  if (record.last === sessionId && previous
    && at.getTime() >= Date.parse(previous) && at.getTime() - Date.parse(previous) < REWRITE_AFTER_MS) return record.sessions;
  return write(storage, { sessions: { ...record.sessions, [sessionId]: at.toISOString() }, last: sessionId }).sessions;
}
