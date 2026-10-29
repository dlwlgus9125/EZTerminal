import { Fragment, type ReactNode } from 'react';

import { Button } from '../../ui/Button';
import { Glyph, Led, type LedTone } from '../../ui/Glyph';
import { useChatContext } from '../ChatContext';

/**
 * A transcript card that reports a result the person can act on (an AI review today; a recap or
 * a suggested task later). It reports, it does not wait: no amber and no attention mark. The
 * lamp always comes with the same state in words, a stopped or empty card says why and how to
 * recover, and both skins offer the same actions as real buttons.
 */

export type ActionCardState = 'queued' | 'running' | 'done' | 'empty' | 'failed' | 'unsupported' | 'stopped';

const LAMP: Readonly<Record<ActionCardState, LedTone>> = {
  queued: 'idle',
  running: 'on',
  done: 'ok',
  empty: 'ok',
  failed: 'red',
  unsupported: 'idle',
  stopped: 'idle',
};

const CLI_TONE: Readonly<Record<ActionCardState, string>> = {
  queued: 'muted',
  running: 'live',
  done: 'success',
  empty: 'success',
  failed: 'danger',
  unsupported: 'muted',
  stopped: 'muted',
};

export interface ActionCardAction {
  readonly id: string;
  readonly label: string;
  /** The name a screen reader hears when the label alone is ambiguous. */
  readonly ariaLabel?: string;
  /** At most one per card: the card's main action. */
  readonly primary?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
  readonly testId?: string;
}

export interface ActionCardNote {
  readonly id: string;
  readonly text: string;
  readonly tone?: 'neutral' | 'danger';
}

export interface ActionCardProps {
  /** The region's accessible name. */
  readonly label: string;
  /** Bubble: the card's title (`AI 검토 결과`). */
  readonly title: string;
  /** CLI: `⏺ name(target) state`. */
  readonly cliName: string;
  readonly cliTarget?: string;
  readonly state: ActionCardState;
  /** The lamp's state in words. */
  readonly stateText: string;
  /** CLI header state, when it says more than the bubble's (`문제 3개`). */
  readonly cliStateText?: string;
  /** Bubble header: who, what scope, when. */
  readonly meta?: ReactNode;
  /** CLI header tail after the state. */
  readonly cliMeta?: string;
  /**
   * The cause or the result in one sentence (a failure's reason, an empty result, a summary). A
   * `danger` message leads with the warning glyph and its `label` in words (`검토 실패`).
   */
  readonly message?: { readonly text: ReactNode; readonly tone?: 'neutral' | 'danger'; readonly label?: string };
  readonly notes?: readonly ActionCardNote[];
  /** What the card shows may be out of date (files changed after it was made): said in words with the refresh glyph. */
  readonly stale?: string;
  /** The list in the active skin (bubble rows, or `⎿` lines in CLI). */
  readonly children?: ReactNode;
  readonly actions?: readonly ActionCardAction[];
  readonly testId?: string;
  readonly kind?: string;
}

function ActionButtons({ actions, cli }: { readonly actions: readonly ActionCardAction[]; readonly cli: boolean }): JSX.Element {
  if (!cli) {
    return (
      <>
        {actions.map((action) => (
          <Button key={action.id} size="sm" variant={action.primary ? 'primary' : 'secondary'} disabled={action.disabled}
            aria-label={action.ariaLabel} onClick={action.onSelect} data-testid={action.testId}>
            {action.label}
          </Button>
        ))}
      </>
    );
  }
  // CLI: text you can press, the way `/` commands read in a terminal, still real buttons.
  return (
    <>
      {actions.map((action, index) => (
        <Fragment key={action.id}>
          {index > 0 && <span className="chat-cli-dim" aria-hidden="true"> · </span>}
          <button type="button" className="chat-cli-action" data-primary={action.primary || undefined} disabled={action.disabled}
            aria-label={action.ariaLabel} onClick={action.onSelect} data-testid={action.testId}>
            {action.label}
          </button>
        </Fragment>
      ))}
    </>
  );
}

export function ActionCard({
  label, title, cliName, cliTarget, state, stateText, cliStateText, meta, cliMeta, message, notes = [], stale, children, actions = [], testId, kind,
}: ActionCardProps): JSX.Element {
  const { skin } = useChatContext();
  if (skin === 'cli') {
    return (
      <section className="chat-cli-line chat-cli-action-card" data-state={state} data-kind={kind} aria-label={label} data-testid={testId}>
        <span className="chat-cli-glyph" data-tone={CLI_TONE[state]} aria-hidden="true">⏺</span>
        <div className="chat-cli-line__body">
          <p className="chat-cli-action-card__head" tabIndex={-1} data-card-heading="">
            <span className="chat-cli-tool__name">{cliName}</span>
            {cliTarget && <span className="chat-cli-tool__target">({cliTarget})</span>}
            {' '}<span className="chat-cli-action-card__state" data-state={state}>{cliStateText ?? stateText}</span>
            {cliMeta && <span className="chat-cli-dim"> · {cliMeta}</span>}
          </p>
          {message && (
            <div className="chat-cli-result" data-tone={message.tone === 'danger' ? 'danger' : 'muted'}>
              <span className="chat-cli-result__elbow" aria-hidden="true">⎿</span>
              <div className="chat-cli-result__body">
                <span className="chat-cli-result__line">
                  {message.tone === 'danger' && <Glyph name="warn" className="chat-cli-action-card__icon" />}
                  {message.label && <strong>{message.label} · </strong>}
                  {message.text}
                </span>
              </div>
            </div>
          )}
          {children}
          {notes.map((note) => (
            <div key={note.id} className="chat-cli-result" data-tone={note.tone === 'danger' ? 'danger' : 'muted'}>
              <span className="chat-cli-result__elbow" aria-hidden="true">⎿</span>
              <div className="chat-cli-result__body"><span className="chat-cli-result__line">{note.text}</span></div>
            </div>
          ))}
          {stale && (
            <div className="chat-cli-result chat-cli-action-card__stale">
              <span className="chat-cli-result__elbow" aria-hidden="true">⎿</span>
              <div className="chat-cli-result__body"><span className="chat-cli-result__line"><Glyph name="refresh" className="chat-cli-action-card__icon" />{stale}</span></div>
            </div>
          )}
          {actions.length > 0 && (
            <p className="chat-cli-action-card__actions">
              <span className="chat-cli-action-card__mark" aria-hidden="true">✻</span>
              <ActionButtons actions={actions} cli />
            </p>
          )}
        </div>
      </section>
    );
  }
  return (
    <section className="chat-action-card" data-state={state} data-kind={kind} aria-label={label} data-testid={testId}>
      <header className="chat-action-card__head">
        <span className="chat-action-card__lamp"><Led tone={LAMP[state]} /></span>
        <span className="chat-action-card__title" tabIndex={-1} data-card-heading="">{title}</span>
        <span className="chat-action-card__state" data-state={state}>{stateText}</span>
        {meta && <span className="chat-action-card__meta">{meta}</span>}
      </header>
      {message && (
        <p className="chat-action-card__message" data-tone={message.tone}>
          {message.tone === 'danger' && <Glyph name="warn" />}
          {message.label && <strong className="chat-action-card__message-label">{message.label}</strong>}
          <span>{message.text}</span>
        </p>
      )}
      {children && <div className="chat-action-card__body">{children}</div>}
      {notes.length > 0 && (
        <ul className="chat-action-card__notes">
          {notes.map((note) => <li key={note.id} data-tone={note.tone}>{note.text}</li>)}
        </ul>
      )}
      {stale && <p className="chat-action-card__stale"><Glyph name="refresh" />{stale}</p>}
      {actions.length > 0 && (
        <footer className="chat-action-card__actions">
          <ActionButtons actions={actions} cli={false} />
        </footer>
      )}
    </section>
  );
}
