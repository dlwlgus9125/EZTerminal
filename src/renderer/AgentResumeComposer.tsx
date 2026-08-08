import { memo, useState } from 'react';

import { useAppTranslation } from './i18n';

export interface AgentResumeComposerProps {
  readonly variant: 'desktop' | 'mobile';
  readonly preparing: boolean;
  readonly initialDraft?: string;
  readonly onSubmit: (prompt: string) => void;
}

/** Keeps keystroke state below the transcript so typing never re-renders history. */
export const AgentResumeComposer = memo(function AgentResumeComposer({
  variant,
  preparing,
  initialDraft = '',
  onSubmit,
}: AgentResumeComposerProps): JSX.Element {
  const { t } = useAppTranslation();
  const [draft, setDraft] = useState(initialDraft);
  const submit = (): void => {
    const prompt = draft.trim();
    if (!prompt || preparing) return;
    onSubmit(prompt);
  };

  if (variant === 'mobile') {
    return (
      <form
        className="mob-agent-history-composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
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
    );
  }

  return (
    <form
      className="cmd-row agent-history-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
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
  );
});
