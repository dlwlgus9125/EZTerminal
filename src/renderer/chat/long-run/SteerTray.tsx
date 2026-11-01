import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { SteeredMessage, SteerFallback } from '../../../shared/long-run';
import { Button } from '../../ui/Button';
import { Glyph, Led } from '../../ui/Glyph';
import { useChatCopy, type ChatCopy } from '../copy';
import './long-run.css';

type SteerCopy = ChatCopy['longRun']['steer'];

/**
 * What the host has confirmed about a message, in words. Nothing here says it arrived: a landed one is a transcript row.
 * Only text being written is dropped, and only on Codex: a tool holds a message on either AI and is not cut.
 */
export function steerStateText(message: SteeredMessage, copy: SteerCopy, codex: boolean): string {
  switch (message.state) {
    case 'on-its-way': return `${copy.onItsWay} · ${codex && message.behind === 'text' ? copy.behind.codex : copy.behind[message.behind ?? 'tool']}`;
    case 'behind-approval': return copy.behindApproval;
    case 'failed': return message.failure ? `${copy.failed} · ${copy.failure[message.failure]}` : copy.failed;
    case 'unconfirmed': return message.caught ? copy.caught[message.caught] : copy.unconfirmed;
  }
}

/** Of the conversation panel: the tray's list never takes more than this, and below that height it folds to one line. */
const LIST_SHARE = 0.24;
const LIST_FLOOR = 64;
const FOLD_BELOW = 560;

/** The panel's real height: a phone's keyboard takes much of it, and viewport units do not see that everywhere. */
function usePanelHeight(element: HTMLElement | null): number | undefined {
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const panel = element?.closest('.structured-agent');
    if (!panel || typeof ResizeObserver === 'undefined') return undefined;
    const read = (): void => setHeight(panel.getBoundingClientRect().height);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [element]);
  return height;
}

/** Two lines of a long message, and the rest on request: only offered when there is more. */
function SteerText({ text }: { readonly text: string }): JSX.Element {
  const copy = useChatCopy().longRun.steer;
  const body = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const element = body.current;
    if (element && !open) setMore(element.scrollHeight > element.clientHeight + 1);
  }, [open, text]);
  return (
    <>
      <p ref={body} className="chat-steer__text" data-open={open || undefined}>{text}</p>
      {more && <button type="button" className="chat-link-button chat-steer__more" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? copy.fold : copy.unfold}</button>}
    </>
  );
}

/**
 * Messages on their way into the running turn. They sit above the message box, not in the transcript: until a message
 * lands it has no place there. Only a landed message's row says it arrived: one that just leaves the list is announced
 * as nothing, since the host may have cancelled or moved it. A failed one is never sent again by a button here (neither
 * AI drops a repeat for us): it can go to the queue or back to the box. It never takes the box or a decision off the
 * screen: its list is capped to a share of the panel and scrolls inside, and a short panel folds it.
 */
export function SteerTray({ messages, codex, fellBack, landedRow, decisionOpen = false, onFocusDecision, onToQueue, onToBox }: {
  readonly messages: readonly SteeredMessage[];
  readonly codex: boolean;
  /** Queued turns that were meant for the running one: each is announced once, with its reason. */
  readonly fellBack?: ReadonlyMap<string, SteerFallback>;
  /** The newest landed row in the transcript: one newer than a message held here is the host confirming it arrived. */
  readonly landedRow?: { readonly id: string; readonly createdAt: string };
  /** A decision waits above the box: on a short panel it has the room, so this stays one line. */
  readonly decisionOpen?: boolean;
  readonly onFocusDecision?: () => boolean;
  readonly onToQueue?: (message: SteeredMessage) => void;
  readonly onToBox: (message: SteeredMessage) => void;
}): JSX.Element {
  const copy = useChatCopy().longRun.steer;
  const [announced, setAnnounced] = useState('');
  const known = useRef(new Map(messages.map((message) => [message.id, message.state])));
  useEffect(() => {
    const changed = messages.find((message) => known.current.get(message.id) !== message.state);
    known.current = new Map(messages.map((message) => [message.id, message.state]));
    if (changed) setAnnounced(copy.announceHeld(steerStateText(changed, copy, codex)));
  }, [codex, copy, messages]);
  // A transcript still loading brings old rows in too: only one newer than what this tray held says anything.
  const landedSeen = useRef(landedRow?.id);
  const heldSince = useRef<string>();
  useEffect(() => {
    for (const { sentAt } of messages) if (!heldSince.current || sentAt < heldSince.current) heldSince.current = sentAt;
    if (landedRow?.id === landedSeen.current) return;
    landedSeen.current = landedRow?.id;
    if (!landedRow || !heldSince.current || landedRow.createdAt < heldSince.current) return;
    if (messages.length === 0) heldSince.current = undefined;
    setAnnounced(copy.announceLanded);
  }, [copy, landedRow, messages]);
  const told = useRef(new Set(fellBack?.keys()));
  useEffect(() => {
    const fresh = [...(fellBack ?? [])].find(([turnId]) => !told.current.has(turnId));
    if (!fresh) return;
    told.current.add(fresh[0]);
    setAnnounced(copy.fellBack[fresh[1]]);
  }, [copy, fellBack]);
  const [section, setSection] = useState<HTMLElement | null>(null);
  const panelHeight = usePanelHeight(section);
  const short = panelHeight !== undefined && panelHeight < FOLD_BELOW;
  const [opened, setOpened] = useState(false);
  const yields = short && decisionOpen;
  const listOpen = !short || (opened && !yields);
  const newest = messages[messages.length - 1];
  const summary = newest ? steerStateText(newest, copy, codex) : undefined;
  return (
    <>
      {messages.length > 0 && (
        <section ref={setSection} className="chat-steer" aria-label={copy.tray} data-testid="chat-steer-tray">
          {yields && <p className="chat-steer__toggle" data-testid="chat-steer-line"><Glyph name="next" /><span>{copy.tray}</span><span>{messages.length}</span><span className="chat-steer__summary">{summary}</span></p>}
          {short && !yields && (
            <button type="button" className="chat-steer__toggle" aria-expanded={opened} onClick={() => setOpened((value) => !value)} data-testid="chat-steer-toggle">
              <Glyph name={opened ? 'down' : 'next'} /><span>{copy.tray}</span><span>{messages.length}</span>
              {!opened && <span className="chat-steer__summary">{summary}</span>}
            </button>
          )}
          {!short && <p className="chat-steer__title"><Glyph name="next" />{copy.tray}<span>{messages.length}</span></p>}
          {listOpen && <ol className="chat-steer__list" tabIndex={0} aria-label={copy.tray} style={panelHeight === undefined ? undefined : { maxHeight: Math.max(LIST_FLOOR, Math.round(panelHeight * LIST_SHARE)) }}>
            {messages.map((message) => (
              <li key={message.id} className="chat-steer__item" data-state={message.state} data-testid="chat-steer-message">
                <SteerText text={message.text} />
                <p className="chat-steer__state">
                  {message.state === 'on-its-way' && <Led tone="on" />}
                  {message.state === 'behind-approval' && <Glyph name="clock" />}
                  {(message.state === 'failed' || message.state === 'unconfirmed') && <Glyph name="warn" />}
                  <span>{steerStateText(message, copy, codex)}</span>
                </p>
                {message.state === 'unconfirmed' && <p className="chat-steer__note">{message.caught ? copy.caughtNote[message.caught] : copy.unconfirmedNote}</p>}
                {message.state === 'behind-approval' && onFocusDecision && (
                  <div className="chat-steer__actions">
                    <Button type="button" variant="ghost" size="sm" onClick={() => onFocusDecision()}>{copy.answer}</Button>
                  </div>
                )}
                {(message.state === 'failed' || message.state === 'unconfirmed') && (
                  <div className="chat-steer__actions">
                    {message.state === 'failed' && message.failure !== 'disconnected' && onToQueue && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => onToQueue(message)} data-testid="chat-steer-to-queue">{copy.toQueue}</Button>
                    )}
                    <Button type="button" variant="ghost" size="sm" onClick={() => onToBox(message)} data-testid="chat-steer-to-box">{copy.toBox}</Button>
                  </div>
                )}
              </li>
            ))}
          </ol>}
        </section>
      )}
      <span className="ez-ui-visually-hidden" aria-live="polite" data-testid="chat-steer-announce">{announced}</span>
    </>
  );
}
