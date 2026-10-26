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

function defaultStorage(): Storage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}

function parseSessions(raw: string | null): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as { sessions?: unknown } | null;
    const sessions = value?.sessions;
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return undefined;
    return Object.fromEntries(Object.entries(sessions as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !Number.isNaN(Date.parse(entry[1]))));
  } catch {
    return undefined;
  }
}

function write(storage: Storage | undefined, sessions: Record<string, string>): ConversationViews {
  const kept = Object.fromEntries(Object.entries(sessions)
    .sort((left, right) => right[1].localeCompare(left[1]))
    .slice(0, MAX_CONVERSATION_VIEWS));
  try { storage?.setItem(CONVERSATION_VIEWS_KEY, JSON.stringify({ sessions: kept })); } catch { /* Kept for this call only. */ }
  return kept;
}

/** Views so far; the first read starts from the inbox's marks so an upgrade is not empty. */
export function readConversationViews(storage: Storage | undefined = defaultStorage()): ConversationViews {
  const stored = parseSessions(storage?.getItem(CONVERSATION_VIEWS_KEY) ?? null);
  if (stored) return stored;
  return write(storage, parseSessions(storage?.getItem(INBOX_SEEN_KEY) ?? null) ?? {});
}

/** Mark a conversation as looked at now; repeated marks within a few seconds are skipped. */
export function noteConversationViewed(
  sessionId: string,
  at: Date = new Date(),
  storage: Storage | undefined = defaultStorage(),
): ConversationViews {
  const views = readConversationViews(storage);
  const last = views[sessionId];
  if (last && at.getTime() - Date.parse(last) < REWRITE_AFTER_MS && at.getTime() >= Date.parse(last)) return views;
  return write(storage, { ...views, [sessionId]: at.toISOString() });
}
