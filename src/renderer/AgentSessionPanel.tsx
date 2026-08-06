import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type UIEvent,
} from 'react';

import type {
  AgentHistoryProvider,
  AgentResumePreparation,
  AgentResumeRootChoice,
  AgentTranscriptPage,
} from '../shared/agent-history';
import { AgentActivityEntry } from './AgentActivityEntry';
import { SafeMarkdown } from './SafeMarkdown';
import type { TerminalResumeBootstrap } from './TerminalPane';
import { useAppTranslation } from './i18n';
import { Button } from './ui';

/** Matches the provider's own transcript prompt, so a resumed pane reads the same. */
export const AGENT_ROLE_LABEL: Record<AgentHistoryProvider, string> = {
  codex: 'codex',
  claude: 'claude',
};

const AGENT_PROVIDER_LABEL: Record<AgentHistoryProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
};

export interface AgentSessionPanelProps {
  readonly historyId: string;
  readonly onOpenReview?: (turnId: string, changedPath?: string) => void;
  readonly renderTerminal: (
    bootstrap: TerminalResumeBootstrap,
    onFailure: (message: string) => void,
  ) => JSX.Element;
}

interface ScrollRestore {
  readonly height: number;
  readonly top: number;
}

interface RootDecision {
  readonly preparation: AgentResumePreparation;
  readonly initialPrompt: string;
}

export function AgentSessionPanel({
  historyId,
  onOpenReview,
  renderTerminal,
}: AgentSessionPanelProps): JSX.Element {
  const { t } = useAppTranslation();
  const [page, setPage] = useState<AgentTranscriptPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [bootstrap, setBootstrap] = useState<TerminalResumeBootstrap | null>(null);
  const [rootDecision, setRootDecision] = useState<RootDecision | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
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
          setPage(null);
          setError(t('agentHub.history.unavailable'));
          return;
        }
        setPage(result);
      })
      .catch(() => {
        if (!cancelled) setError(t('agentHub.history.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [historyId, reloadToken, t]);

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

  if (bootstrap) {
    return renderTerminal(bootstrap, () => {
      setDraft(bootstrap.initialPrompt);
      setBootstrap(null);
      setError(t('agentHub.history.resumeFailed'));
    });
  }

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
      setError(t('agentHub.history.earlierFailed'));
      return;
    }
    setPage((current) => current ? {
      historyId,
      provider: next.provider,
      turns: [...next.turns, ...current.turns],
      nextCursor: next.nextCursor,
    } : next);
  };

  const handleScroll = (event: UIEvent<HTMLDivElement>): void => {
    if (event.currentTarget.scrollTop <= 96) void loadEarlier();
  };

  const commitResume = (
    preparation: AgentResumePreparation,
    initialPrompt: string,
    rootChoice: AgentResumeRootChoice,
  ): void => {
    const roots = rootChoice === 'current' ? preparation.currentRoots : preparation.recordedRoots;
    const missing = rootChoice === 'current'
      ? preparation.missingCurrentRoots
      : preparation.missingRecordedRoots;
    const cwd = roots[0];
    if (!cwd || missing.length > 0) {
      setError(t('agentHub.history.rootsMissing'));
      return;
    }
    setError(null);
    setRootDecision(null);
    setBootstrap({
      kind: 'resume',
      historyId,
      provider: preparation.provider,
      cwd,
      rootChoice,
      revision: preparation.revision,
      initialPrompt,
    });
  };

  const beginSession = async (): Promise<void> => {
    const initialPrompt = draft.trim();
    if (!initialPrompt || preparing) return;
    setPreparing(true);
    setError(null);
    setRootDecision(null);
    const preparation = await window.ezterminal.prepareAgentResume(historyId).catch(() => null);
    setPreparing(false);
    if (!preparation || !preparation.canResume) {
      setError(t('agentHub.history.resumeFailed'));
      return;
    }
    const canUseCurrent = preparation.currentRoots.length > 0
      && preparation.missingCurrentRoots.length === 0;
    const canUseRecorded = preparation.recordedRoots.length > 0
      && preparation.missingRecordedRoots.length === 0;
    if (!canUseCurrent && !canUseRecorded) {
      setError(t('agentHub.history.rootsMissing'));
      return;
    }
    if (!preparation.rootsMatch) {
      setRootDecision({ preparation, initialPrompt });
      return;
    }
    commitResume(preparation, initialPrompt, canUseCurrent ? 'current' : 'recorded');
  };

  return (
    <section
      className="pane agent-history-terminal"
      data-provider={page?.provider}
      data-testid="agent-session-panel"
    >
      <div
        className="block-list agent-history-terminal__scroll"
        data-testid="agent-history-transcript"
        ref={transcriptRef}
        aria-busy={loading || loadingMore}
        onScroll={handleScroll}
      >
        <header className="agent-history-terminal__header">
          <span className={page ? 'agent-provider-badge' : undefined}>
            {page ? AGENT_PROVIDER_LABEL[page.provider] : 'Agent'}
          </span>
          <small>{t('agentHub.history.continue')}</small>
        </header>
        {loadingMore && (
          <div className="agent-history-terminal__status">{t('agentHub.history.loadingEarlier')}</div>
        )}
        {loading && (
          <div className="agent-history-terminal__status">{t('agentHub.history.loading')}</div>
        )}
        {error && (
          <div className="agent-history-terminal__error" role="alert">
            <span>{error}</span>
            {!loading && !page && (
              <Button size="sm" variant="ghost" onClick={() => setReloadToken((value) => value + 1)}>
                {t('common.retry')}
              </Button>
            )}
          </div>
        )}
        {!loading && !error && page?.turns.length === 0 && (
          <div className="agent-history-terminal__status">{t('agentHub.history.empty')}</div>
        )}
        {page && page.turns.map((turn) => (
          <section className="agent-history-terminal__turn" key={turn.id} data-status={turn.status}>
            {turn.entries.map((entry) => entry.type === 'message' ? (
              <article
                className={`agent-history-terminal__message agent-history-terminal__message--${entry.role}`}
                data-provider={entry.role === 'assistant' ? page.provider : undefined}
                key={entry.id}
              >
                <span className="agent-history-terminal__role">
                  {entry.role === 'user' ? t('agentHub.history.user') : AGENT_ROLE_LABEL[page.provider]}
                </span>
                <SafeMarkdown
                  className="agent-history-terminal__markdown"
                  markdown={entry.markdown}
                  openExternalHttpUrl={(url) => {
                    void window.ezterminalDesktop?.openExternalHttpUrl(url);
                  }}
                  blockedImageLabel={(value) => t('agentHub.history.imageBlocked', { value })}
                />
              </article>
            ) : (
              <AgentActivityEntry
                key={entry.id}
                entry={entry}
                label={t(`agentHub.activityKind.${entry.kind}`)}
                onActivate={entry.kind === 'file-change' && onOpenReview
                  ? (changedPath) => onOpenReview(turn.id, changedPath)
                  : undefined}
              />
            ))}
          </section>
        ))}
      </div>
      {rootDecision && (
        <section className="agent-root-decision" role="group" aria-labelledby="agent-root-decision-title">
          <div>
            <strong id="agent-root-decision-title">{t('agentHub.history.chooseRootsTitle')}</strong>
            <p>{t('agentHub.history.chooseRootsDescription')}</p>
          </div>
          {([
            ['recorded', t('agentHub.history.recordedRoots')],
            ['current', t('agentHub.history.currentRoots')],
          ] as const).map(([choice, label]) => {
            const roots = choice === 'recorded'
              ? rootDecision.preparation.recordedRoots
              : rootDecision.preparation.currentRoots;
            const missing = choice === 'recorded'
              ? rootDecision.preparation.missingRecordedRoots
              : rootDecision.preparation.missingCurrentRoots;
            const disabled = roots.length === 0 || missing.length > 0;
            return (
              <div className="agent-root-option" key={choice} data-disabled={disabled || undefined}>
                <strong>{label}</strong>
                <ul>
                  {roots.map((root) => (
                    <li key={root} data-missing={missing.includes(root) || undefined}>
                      <code>{root}</code>
                      {missing.includes(root) && <span>{t('agentHub.history.missing')}</span>}
                    </li>
                  ))}
                </ul>
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() => commitResume(
                    rootDecision.preparation,
                    rootDecision.initialPrompt,
                    choice,
                  )}
                >
                  {choice === 'recorded'
                    ? t('agentHub.history.useRecorded')
                    : t('agentHub.history.useCurrent')}
                </Button>
              </div>
            );
          })}
        </section>
      )}
      <form
        className="cmd-row agent-history-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void beginSession();
        }}
      >
        <span className="prompt-sigil prompt-sigil--input" aria-hidden="true">›</span>
        <input
          className="cmd-input"
          value={draft}
          maxLength={65_536}
          aria-label={t('agentHub.history.inputLabel')}
          placeholder={t('agentHub.history.inputPlaceholder')}
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
          {preparing ? t('agentHub.history.opening') : t('agentHub.history.continue')}
        </button>
      </form>
    </section>
  );
}
