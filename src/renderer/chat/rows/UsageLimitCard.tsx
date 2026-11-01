import { useEffect, useRef, useState } from 'react';

import { useChatContext } from '../ChatContext';
import { formatClock, useChatCopy } from '../copy';
import { limitView, type LimitActionId } from '../long-run/long-run-presentation';
import type { ChatRow } from '../model/types';
import { providerName } from '../review/review-presentation';
import { ActionCard, type ActionCardAction } from './ActionCard';
import '../long-run/long-run.css';

type RowOf<K extends ChatRow['kind']> = Extract<ChatRow, { kind: K }>;

/**
 * A turn stopped at a usage limit. Nothing arrives when a limit lifts, so the card says what the app will do and
 * when, and what it will send. Only an ask-first case waits on the person, and even then amber stays in the list and the
 * header: the card reports, as every ActionCard does. A change of state is said once; when the pressed button goes,
 * focus moves to the card's title.
 */
export function UsageLimitCard({ row }: { readonly row: RowOf<'usage-limit'> }): JSX.Element {
  const copy = useChatCopy();
  const context = useChatContext();
  const { limit } = row;
  const limitCopy = copy.longRun.limit;
  const view = limitView(limit, limitCopy, context.locale, row.approvalOpen === true);
  const provider = providerName(limit.providerId);
  const clock = formatClock(limit.stoppedAt, context.locale);
  // An unknown window has no name beyond the card's own title.
  const who = limit.window === 'unknown' ? provider : `${provider} · ${limitCopy.window[limit.window]}`;
  const anchor = useRef<HTMLSpanElement>(null);
  const pressed = useRef(false);
  const seen = useRef(limit.phase);
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    if (seen.current === limit.phase) return;
    seen.current = limit.phase;
    setAnnounced(`${limitCopy.card} · ${limitCopy.state[limit.phase]}`);
    if (!pressed.current) return;
    pressed.current = false;
    anchor.current?.previousElementSibling?.querySelector<HTMLElement>('[data-card-heading]')?.focus();
  }, [limit.phase, limitCopy]);
  const press = (id: LimitActionId): void => {
    if (id === 'focus-decision') { context.onFocusDecision?.(); return; }
    pressed.current = true;
    context.onLongRunAction?.({ kind: id, stopId: limit.stopId });
  };
  const actions: ActionCardAction[] = context.onLongRunAction
    ? view.actions.map((action) => ({
      id: action.id, label: limitCopy.actions[action.id], ...(action.primary ? { primary: true } : {}),
      ...(action.ariaLabel ? { ariaLabel: action.ariaLabel } : {}), onSelect: () => press(action.id), testId: `chat-limit-${action.id}`,
    })) : [];
  return (
    <>
      <ActionCard
        kind="usage-limit"
        testId="chat-usage-limit-card"
        cliNeutral
        label={`${limitCopy.card} · ${view.stateText} · ${provider}`}
        title={limitCopy.card}
        cliName={limitCopy.card}
        cliTarget={provider}
        state={view.state}
        stateText={view.stateText}
        meta={(
          <>
            <span className="chat-wrap-up-meta__who">{who}</span>
            <span className="chat-wrap-up-meta__time"><time dateTime={limit.stoppedAt}>{clock}</time></span>
          </>
        )}
        cliMeta={limit.window === 'unknown' ? clock : `${limitCopy.window[limit.window]} · ${clock}`}
        message={view.message}
        notes={view.notes}
        actions={actions}
      />
      <span ref={anchor} className="ez-ui-visually-hidden" aria-live="polite" data-testid="chat-limit-announce">{announced}</span>
    </>
  );
}
