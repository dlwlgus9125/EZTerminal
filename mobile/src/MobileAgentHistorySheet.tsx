import { Browser } from '@capacitor/browser';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type UIEvent,
} from 'react';

import { AgentActivityEntry } from '../../src/renderer/AgentActivityEntry';
import { SafeMarkdown } from '../../src/renderer/SafeMarkdown';
import { useAppTranslation } from '../../src/renderer/i18n';
import type {
  AgentHistorySessionSummary,
  AgentResumeBootstrap,
  AgentResumePreparation,
  AgentResumeRootChoice,
  AgentTranscriptPage,
} from '../../src/shared/agent-history';
import { MobileActionSheet } from './MobileActionSheet';

interface RootDecision {
  readonly preparation: AgentResumePreparation;
  readonly initialPrompt: string;
}

export function MobileAgentHistorySheet({
  session,
  onClose,
  onResume,
}: {
  readonly session: AgentHistorySessionSummary;
  readonly onClose: () => void;
  readonly onResume: (bootstrap: AgentResumeBootstrap) => Promise<void>;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [page, setPage] = useState<AgentTranscriptPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [rootDecision, setRootDecision] = useState<RootDecision | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const loadingMoreRef = useRef(false);
  const restoreRef = useRef<{ readonly height: number; readonly top: number } | null>(null);
  const initialScrollRef = useRef(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    initialScrollRef.current = true;
    void window.ezterminal.readAgentHistory(session.historyId, undefined, 20)
      .then((result) => {
        if (!alive) return;
        setPage(result);
        if (!result) setError(t('agentHub.history.unavailable'));
      })
      .catch(() => {
        if (alive) setError(t('agentHub.history.loadFailed'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [reloadToken, session.historyId, t]);

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
      setError(t('agentHub.history.earlierFailed'));
      return;
    }
    setPage((current) => current ? {
      historyId: current.historyId,
      provider: current.provider,
      turns: [...next.turns, ...current.turns],
      nextCursor: next.nextCursor,
    } : next);
  };

  const commitResume = async (
    preparation: AgentResumePreparation,
    initialPrompt: string,
    rootChoice: AgentResumeRootChoice,
  ): Promise<void> => {
    const roots = rootChoice === 'current' ? preparation.currentRoots : preparation.recordedRoots;
    const missing = rootChoice === 'current'
      ? preparation.missingCurrentRoots
      : preparation.missingRecordedRoots;
    const cwd = roots[0];
    if (!cwd || missing.length > 0) {
      setError(t('agentHub.history.rootsMissing'));
      return;
    }
    setPreparing(true);
    setRootDecision(null);
    setError(null);
    const bootstrap: AgentResumeBootstrap = {
      kind: 'resume',
      historyId: session.historyId,
      provider: preparation.provider,
      cwd,
      rootChoice,
      revision: preparation.revision,
      initialPrompt,
    };
    try {
      await onResume(bootstrap);
    } catch {
      setDraft(initialPrompt);
      setError(t('agentHub.history.resumeFailed'));
      setPreparing(false);
    }
  };

  const beginSession = async (): Promise<void> => {
    const initialPrompt = draft.trim();
    if (!initialPrompt || preparing) return;
    setPreparing(true);
    setError(null);
    setRootDecision(null);
    const preparation = await window.ezterminal
      .prepareAgentResume(session.historyId)
      .catch(() => null);
    setPreparing(false);
    if (!preparation?.canResume) {
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
    await commitResume(preparation, initialPrompt, canUseCurrent ? 'current' : 'recorded');
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
        aria-busy={loading || loadingMore}
        onScroll={(event: UIEvent<HTMLDivElement>) => {
          if (event.currentTarget.scrollTop <= 80) void loadEarlier();
        }}
      >
        {loadingMore && <p className="mob-empty">{t('agentHub.history.loadingEarlier')}</p>}
        {loading && <p className="mob-empty">{t('agentHub.history.loading')}</p>}
        {error && (
          <div className="mob-agent-error" role="alert">
            <span>{error}</span>
            {!loading && !page && (
              <button
                type="button"
                className="mob-btn-ghost"
                onClick={() => setReloadToken((value) => value + 1)}
              >
                {t('common.retry')}
              </button>
            )}
          </div>
        )}
        {!loading && !error && page?.turns.length === 0 && (
          <p className="mob-empty">{t('agentHub.history.empty')}</p>
        )}
        {page?.turns.map((turn) => (
          <section key={turn.id} className="mob-agent-history-turn" data-status={turn.status}>
            {turn.entries.map((entry) => entry.type === 'message' ? (
              <article
                key={entry.id}
                className={`mob-agent-history-message mob-agent-history-message--${entry.role}`}
              >
                <strong>
                  {entry.role === 'user' ? t('agentHub.history.user') : session.provider}
                </strong>
                <SafeMarkdown
                  className="mob-agent-history-markdown"
                  markdown={entry.markdown}
                  openExternalHttpUrl={(url) => {
                    void Browser.open({ url });
                  }}
                  blockedImageLabel={(value) => t('agentHub.history.imageBlocked', { value })}
                />
              </article>
            ) : (
              <AgentActivityEntry
                key={entry.id}
                entry={entry}
                label={t(`agentHub.activityKind.${entry.kind}`)}
              />
            ))}
          </section>
        ))}
      </div>
      {rootDecision && (
        <section className="mob-agent-root-decision" role="group">
          <h3>{t('agentHub.history.chooseRootsTitle')}</h3>
          <p>{t('agentHub.history.chooseRootsDescription')}</p>
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
              <div className="mob-agent-root-option" key={choice} data-disabled={disabled || undefined}>
                <strong>{label}</strong>
                <ul>
                  {roots.map((root) => (
                    <li key={root} data-missing={missing.includes(root) || undefined}>
                      <code>{root}</code>
                      {missing.includes(root) && <span>{t('agentHub.history.missing')}</span>}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="mob-btn-ghost"
                  disabled={disabled}
                  onClick={() => void commitResume(
                    rootDecision.preparation,
                    rootDecision.initialPrompt,
                    choice,
                  )}
                >
                  {choice === 'recorded'
                    ? t('agentHub.history.useRecorded')
                    : t('agentHub.history.useCurrent')}
                </button>
              </div>
            );
          })}
        </section>
      )}
      <form
        className="mob-agent-history-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void beginSession();
        }}
      >
        <textarea
          value={draft}
          rows={2}
          maxLength={65_536}
          aria-label={t('agentHub.history.inputLabel')}
          placeholder={t('agentHub.history.inputPlaceholder')}
          disabled={preparing}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="mob-cta" disabled={!draft.trim() || preparing}>
          {preparing ? t('agentHub.history.opening') : t('agentHub.history.continue')}
        </button>
      </form>
    </MobileActionSheet>
  );
}
