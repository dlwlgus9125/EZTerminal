import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type UIEvent,
} from 'react';

import type {
  AgentHistorySessionSummary,
  AgentResumeBootstrap,
  AgentTranscriptPage,
} from '../../src/shared/agent-history';
import { MobileActionSheet } from './MobileActionSheet';

export function MobileAgentHistorySheet({
  session,
  onClose,
  onResume,
}: {
  readonly session: AgentHistorySessionSummary;
  readonly onClose: () => void;
  readonly onResume: (bootstrap: AgentResumeBootstrap, cwd: string) => Promise<void>;
}): JSX.Element {
  const [page, setPage] = useState<AgentTranscriptPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [preparing, setPreparing] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const loadingMoreRef = useRef(false);
  const restoreRef = useRef<{ readonly height: number; readonly top: number } | null>(null);
  const initialScrollRef = useRef(true);

  useEffect(() => {
    let alive = true;
    void window.ezterminal.readAgentHistory(session.historyId, undefined, 20)
      .then((result) => {
        if (!alive) return;
        setPage(result);
        if (!result) setError('This local session is no longer available.');
      })
      .catch(() => {
        if (alive) setError('Could not read the local session history.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [session.historyId]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !page) return;
    const restore = restoreRef.current;
    if (restore) {
      viewport.scrollTop = viewport.scrollHeight - restore.height + restore.top;
      restoreRef.current = null;
    } else if (initialScrollRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
      initialScrollRef.current = false;
    }
  }, [page]);

  const loadEarlier = async (): Promise<void> => {
    const cursor = page?.nextCursor;
    const viewport = viewportRef.current;
    if (!cursor || !viewport || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    restoreRef.current = { height: viewport.scrollHeight, top: viewport.scrollTop };
    const next = await window.ezterminal.readAgentHistory(session.historyId, cursor, 20)
      .catch(() => null);
    loadingMoreRef.current = false;
    setLoadingMore(false);
    if (!next) {
      restoreRef.current = null;
      setError('Could not read earlier local history.');
      return;
    }
    setPage((current) => current ? {
      historyId: current.historyId,
      turns: [...next.turns, ...current.turns],
      nextCursor: next.nextCursor,
    } : next);
  };

  const handleScroll = (event: UIEvent<HTMLDivElement>): void => {
    if (event.currentTarget.scrollTop <= 80) void loadEarlier();
  };

  const send = async (): Promise<void> => {
    const initialPrompt = draft.trim();
    if (!initialPrompt || preparing) return;
    setPreparing(true);
    setError(null);
    const preparation = await window.ezterminal.prepareAgentResume(session.historyId).catch(() => null);
    if (!preparation || !preparation.canResume) {
      setPreparing(false);
      setError('Could not open this session from its project folder.');
      return;
    }
    const useCurrent = preparation.currentRoots.length > 0
      && preparation.missingCurrentRoots.length === 0;
    const roots = useCurrent ? preparation.currentRoots : preparation.recordedRoots;
    const cwd = roots[0];
    if (!cwd) {
      setPreparing(false);
      setError('The project folder for this session is no longer available.');
      return;
    }
    await onResume({
      historyId: session.historyId,
      rootChoice: useCurrent ? 'current' : 'recorded',
      revision: preparation.revision,
      initialPrompt,
    }, cwd);
    setPreparing(false);
  };

  return (
    <MobileActionSheet
      title={session.title}
      onClose={onClose}
      variant="fullscreen"
      testId="mobile-agent-history"
      className="mob-agent-history-shell"
      contentClassName="mob-agent-history-content"
    >
      <div
        className="mob-agent-history-transcript"
        ref={viewportRef}
        onScroll={handleScroll}
      >
        {loadingMore && <p className="mob-empty">Loading earlier history…</p>}
        {loading && <p className="mob-empty">Loading local history…</p>}
        {error && <p className="mob-agent-error" role="alert">{error}</p>}
        {page?.turns.map((turn) => (
          <section key={turn.id} className="mob-agent-history-turn">
            {turn.entries.map((entry) => entry.type === 'message' ? (
              <article key={entry.id} className={`mob-agent-history-message mob-agent-history-message--${entry.role}`}>
                <strong>{entry.role === 'user' ? '❯' : 'codex'}</strong>
                <div>{entry.markdown}</div>
              </article>
            ) : (
              <div key={entry.id} className="mob-agent-history-activity">
                <span>{entry.kind}</span>
                <code>{entry.summary}</code>
              </div>
            ))}
          </section>
        ))}
      </div>
      <form
        className="mob-agent-history-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          rows={2}
          maxLength={65_536}
          placeholder="Message"
          disabled={preparing}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="submit"
          className="mob-cta"
          disabled={!draft.trim() || preparing}
        >
          {preparing ? 'Opening…' : 'Send'}
        </button>
      </form>
    </MobileActionSheet>
  );
}
