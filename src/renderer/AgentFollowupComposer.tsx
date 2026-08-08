import { memo, useState } from 'react';

import { useAppTranslation } from './i18n';

export interface AgentFollowupComposerProps {
  readonly activityId: string;
  readonly providerLabel: string;
  readonly variant: 'desktop' | 'mobile';
  readonly disconnected: boolean;
  readonly sending: boolean;
  readonly anotherSending: boolean;
  readonly onSend: (activityId: string, text: string) => Promise<string | null>;
}

/** Per-card draft ownership prevents one follow-up field from repainting the hub. */
export const AgentFollowupComposer = memo(function AgentFollowupComposer({
  activityId,
  providerLabel,
  variant,
  disconnected,
  sending,
  anotherSending,
  onSend,
}: AgentFollowupComposerProps): JSX.Element {
  const { t } = useAppTranslation();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const errorId = variant === 'mobile'
    ? `mobile-agent-followup-error-${activityId}`
    : `agent-followup-error-${activityId}`;

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || disconnected || sending || anotherSending) return;
    setError(null);
    const message = await onSend(activityId, text);
    if (message === null) setDraft('');
    else setError(message);
  };

  if (variant === 'mobile') {
    return (
      <>
        <form
          className="mob-agent-followup"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <input
            value={draft}
            maxLength={8192}
            disabled={disconnected || sending}
            aria-label={t('agentHub.followupWith', { provider: providerLabel })}
            aria-describedby={error ? errorId : undefined}
            placeholder={t('agentHub.followupPlaceholder')}
            onChange={(event) => setDraft(event.target.value.replace(/[\r\n]+/g, ' '))}
            data-testid="agent-followup-input"
          />
          <button
            type="submit"
            className="mob-btn-ghost"
            disabled={disconnected || sending || anotherSending || !draft.trim()}
            aria-label={t('agentHub.sendFollowup')}
          >
            {t('agentHub.send')}
          </button>
        </form>
        {error && <p className="mob-agent-error" id={errorId} role="alert">{error}</p>}
      </>
    );
  }

  return (
    <form
      className="agent-followup"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <input
        className="agent-followup-input"
        value={draft}
        maxLength={8192}
        disabled={disconnected || sending}
        aria-label={t('agentHub.followupWith', { provider: providerLabel })}
        aria-describedby={error ? errorId : undefined}
        placeholder={t('agentHub.followupPlaceholder')}
        onChange={(event) => setDraft(event.target.value.replace(/[\r\n]+/g, ' '))}
      />
      <button
        type="submit"
        className="btn btn-split"
        disabled={disconnected || sending || anotherSending || !draft.trim()}
        aria-label={t('agentHub.sendFollowup')}
      >
        {t('agentHub.send')}
      </button>
      {error && <div className="agent-followup-error" id={errorId} role="alert">{error}</div>}
    </form>
  );
});
