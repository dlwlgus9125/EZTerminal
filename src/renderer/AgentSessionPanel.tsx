import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type UIEvent,
} from 'react';

import type { AgentTranscriptPage } from '../shared/agent-history';
import type { TerminalResumeBootstrap } from './TerminalPane';

export interface AgentSessionPanelProps {
  readonly historyId: string;
  readonly renderTerminal: (bootstrap: TerminalResumeBootstrap) => JSX.Element;
}

interface ScrollRestore {
  readonly height: number;
  readonly top: number;
}

export function AgentSessionPanel({
  historyId,
  renderTerminal,
}: AgentSessionPanelProps): JSX.Element {
  const [page, setPage] = useState<AgentTranscriptPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [bootstrap, setBootstrap] = useState<TerminalResumeBootstrap | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const loadingMoreRef = useRef(false);
  const restoreRef = useRef<ScrollRestore | null>(null);
  const initialScrollRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    initialScrollRef.current = true;
    setLoading(true);
    setError(null);
    void window.ezterminal.readAgentHistory(historyId, undefined, 20)
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setError('This local session is no longer available.');
          return;
        }
        setPage(result);
      })
      .catch(() => {
        if (!cancelled) setError('Could not read the local session history.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [historyId]);

  useLayoutEffect(() => {
    const viewport = transcriptRef.current;
    if (!viewport || !page) return;
    const restore = restoreRef.current;
    if (restore) {
      viewport.scrollTop = viewport.scrollHeight - restore.height + restore.top;
      restoreRef.current = null;
      return;
    }
    if (initialScrollRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
      initialScrollRef.current = false;
    }
  }, [page]);

  if (bootstrap) return renderTerminal(bootstrap);

  const loadEarlier = async (): Promise<void> => {
    const viewport = transcriptRef.current;
    const cursor = page?.nextCursor;
    if (!viewport || !cursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    restoreRef.current = { height: viewport.scrollHeight, top: viewport.scrollTop };
    const next = await window.ezterminal
      .readAgentHistory(historyId, cursor, 20)
      .catch(() => null);
    loadingMoreRef.current = false;
    setLoadingMore(false);
    if (!next) {
      restoreRef.current = null;
      setError('Could not read earlier local history.');
      return;
    }
    setPage((current) => current ? {
      historyId,
      turns: [...next.turns, ...current.turns],
      nextCursor: next.nextCursor,
    } : next);
  };

  const handleScroll = (event: UIEvent<HTMLDivElement>): void => {
    if (event.currentTarget.scrollTop <= 96) void loadEarlier();
  };

  const beginSession = async (): Promise<void> => {
    const initialPrompt = draft.trim();
    if (!initialPrompt || preparing) return;
    setPreparing(true);
    setError(null);
    const preparation = await window.ezterminal.prepareAgentResume(historyId).catch(() => null);
    setPreparing(false);
    if (!preparation || !preparation.canResume) {
      setError('Could not open this session from its project folder.');
      return;
    }
    const canUseCurrent = preparation.currentRoots.length > 0
      && preparation.missingCurrentRoots.length === 0;
    const canUseRecorded = preparation.recordedRoots.length > 0
      && preparation.missingRecordedRoots.length === 0;
    if (!canUseCurrent && !canUseRecorded) {
      setError('The project folder for this session is no longer available.');
      return;
    }
    setBootstrap({
      historyId,
      rootChoice: canUseCurrent ? 'current' : 'recorded',
      revision: preparation.revision,
      initialPrompt,
    });
  };

  return (
    <section className="pane agent-history-terminal" data-testid="agent-session-panel">
      <div
        className="block-list agent-history-terminal__scroll"
        data-testid="agent-history-transcript"
        ref={transcriptRef}
        aria-busy={loading || loadingMore}
        onScroll={handleScroll}
      >
        {loadingMore && <div className="agent-history-terminal__status">Loading earlier history…</div>}
        {loading && <div className="agent-history-terminal__status">Loading local history…</div>}
        {error && <div className="agent-history-terminal__error" role="alert">{error}</div>}
        {!loading && !error && page?.turns.length === 0 && (
          <div className="agent-history-terminal__status">No displayable conversation turns were found.</div>
        )}
        {page?.turns.map((turn) => (
          <section className="agent-history-terminal__turn" key={turn.id} data-status={turn.status}>
            {turn.entries.map((entry) => entry.type === 'message' ? (
              <article
                className={`agent-history-terminal__message agent-history-terminal__message--${entry.role}`}
                key={entry.id}
              >
                <span className="agent-history-terminal__role">
                  {entry.role === 'user' ? '❯' : 'codex'}
                </span>
                <div>{entry.markdown}</div>
              </article>
            ) : (
              <div className="agent-history-terminal__activity" key={entry.id}>
                <span>{entry.kind}</span>
                <code>{entry.summary}</code>
                {entry.status && <small>{entry.status}</small>}
              </div>
            ))}
          </section>
        ))}
      </div>
      <form
        className="cmd-row"
        onSubmit={(event) => {
          event.preventDefault();
          void beginSession();
        }}
      >
        <span className="prompt-sigil prompt-sigil--input" aria-hidden="true">❯</span>
        <input
          className="cmd-input"
          value={draft}
          maxLength={65_536}
          aria-label="Command input"
          data-testid="cmd-input"
          disabled={preparing}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="submit"
          className="btn btn-run"
          disabled={!draft.trim() || preparing}
          data-testid="btn-run"
        >
          {preparing ? 'Opening…' : 'Run'}
        </button>
      </form>
    </section>
  );
}
