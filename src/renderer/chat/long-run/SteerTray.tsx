import { useEffect, useRef, useState } from 'react';

import type { SteeredMessage } from '../../../shared/long-run';
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
    case 'unconfirmed': return copy.unconfirmed;
  }
}

/**
 * 시안: messages on their way into the running turn. They sit above the message box, not in the transcript: until a
 * message lands it has no place there. It leaves this list when it lands, and the list never says more than the host
 * confirmed. A failed one is never sent again by a button here (neither AI drops a repeat for us): it can go to the
 * queue or back to the box.
 */
export function SteerTray({ messages, codex, onFocusDecision, onToQueue, onToBox }: {
  readonly messages: readonly SteeredMessage[];
  readonly codex: boolean;
  readonly onFocusDecision?: () => boolean;
  readonly onToQueue?: (message: SteeredMessage) => void;
  readonly onToBox: (message: SteeredMessage) => void;
}): JSX.Element {
  const copy = useChatCopy().longRun.steer;
  const [announced, setAnnounced] = useState('');
  const known = useRef(new Map(messages.map((message) => [message.id, message.state])));
  const moved = useRef(new Set<string>());
  useEffect(() => {
    const landed = [...known.current.keys()].some((id) => !moved.current.has(id) && !messages.some((message) => message.id === id));
    const changed = messages.find((message) => known.current.get(message.id) !== message.state);
    known.current = new Map(messages.map((message) => [message.id, message.state]));
    if (changed) setAnnounced(copy.announceHeld(steerStateText(changed, copy, codex)));
    else if (landed) setAnnounced(copy.announceLanded);
  }, [codex, copy, messages]);
  const toQueue = (message: SteeredMessage): void => { moved.current.add(message.id); onToQueue?.(message); };
  const toBox = (message: SteeredMessage): void => { moved.current.add(message.id); onToBox(message); };
  return (
    <>
      {messages.length > 0 && (
        <section className="chat-steer" aria-label={copy.tray} data-testid="chat-steer-tray">
          <p className="chat-steer__title"><Glyph name="next" />{copy.tray}<span>{messages.length}</span></p>
          <ol>
            {messages.map((message) => (
              <li key={message.id} className="chat-steer__item" data-state={message.state} data-testid="chat-steer-message">
                <p className="chat-steer__text">{message.text}</p>
                <p className="chat-steer__state">
                  {message.state === 'on-its-way' && <Led tone="on" />}
                  {message.state === 'behind-approval' && <Glyph name="clock" />}
                  {(message.state === 'failed' || message.state === 'unconfirmed') && <Glyph name="warn" />}
                  <span>{steerStateText(message, copy, codex)}</span>
                </p>
                {message.state === 'unconfirmed' && <p className="chat-steer__note">{copy.unconfirmedNote}</p>}
                {message.state === 'behind-approval' && onFocusDecision && (
                  <div className="chat-steer__actions">
                    <Button type="button" variant="ghost" size="sm" onClick={() => onFocusDecision()}>{copy.answer}</Button>
                  </div>
                )}
                {(message.state === 'failed' || message.state === 'unconfirmed') && (
                  <div className="chat-steer__actions">
                    {message.state === 'failed' && message.failure !== 'disconnected' && onToQueue && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => toQueue(message)} data-testid="chat-steer-to-queue">{copy.toQueue}</Button>
                    )}
                    <Button type="button" variant="ghost" size="sm" onClick={() => toBox(message)} data-testid="chat-steer-to-box">{copy.toBox}</Button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      <span className="ez-ui-visually-hidden" aria-live="polite" data-testid="chat-steer-announce">{announced}</span>
    </>
  );
}
