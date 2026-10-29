import { useEffect, useRef, useState } from 'react';

import { useChatLocale } from '../chat/copy';
import { Button, IconButton } from '../ui';
import { Glyph, glyphIcon } from '../ui/Glyph';
import { useResultsCopy } from './copy';
import { formatReviewComments, REVIEW_DRAFT_LIMIT, type ReviewComment } from './results-format';
import type { ResultsSendResult } from './results-source-store';
import './review-comment-tray.css';

type SendState =
  | { readonly phase: 'idle' | 'sending' }
  | { readonly phase: 'sent'; readonly queued: boolean; readonly position?: number }
  | { readonly phase: 'error'; readonly message: string };

/**
 * The review comments collected to go together (Results › Changes on the PC, the review sheet on the
 * phone): each can be removed, and all of them are sent as a message of their own or put into the
 * message box. Only the comments that went are taken off — ones added while sending stay — and a
 * place in the queue is said only when the host gave it.
 */
export function ReviewCommentTray({ comments, onRemove, onTaken, sendNow, insertIntoDraft, turnActive, draftUnavailable }: {
  readonly comments: readonly ReviewComment[];
  readonly onRemove: (id: string) => void;
  /** These comments went (sent, or put into the message box): take them off. */
  readonly onTaken: (ids: readonly string[]) => void;
  readonly sendNow?: (text: string) => Promise<ResultsSendResult>;
  readonly insertIntoDraft?: (text: string) => void;
  /** The conversation is answering: a send waits in its queue. */
  readonly turnActive: boolean;
  readonly draftUnavailable?: 'history' | 'disabled';
}): JSX.Element | null {
  const copy = useResultsCopy();
  const locale = useChatLocale();
  const [sendState, setSendState] = useState<SendState>({ phase: 'idle' });
  const [inserted, setInserted] = useState(false);
  const draftText = formatReviewComments(comments, locale);
  const tooLong = draftText.length > REVIEW_DRAFT_LIMIT;
  const ids = comments.map((comment) => comment.id);
  // A new comment starts a new round: the last receipt or error no longer applies (unless a send is on its way).
  const known = useRef(new Set(ids));
  const signature = ids.join('|');
  useEffect(() => {
    const added = ids.some((id) => !known.current.has(id));
    known.current = new Set(ids);
    if (!added) return;
    setInserted(false);
    setSendState((state) => (state.phase === 'sending' ? state : { phase: 'idle' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature is the ids
  }, [signature]);

  const send = async (): Promise<void> => {
    if (!sendNow || tooLong || !draftText || sendState.phase === 'sending') return;
    const sent = ids;
    setSendState({ phase: 'sending' });
    setInserted(false);
    const result = await sendNow(draftText).catch((): ResultsSendResult => ({ ok: false, message: '' }));
    if (result.ok) {
      onTaken(sent);
      setSendState({ phase: 'sent', queued: result.queued, ...(result.position !== undefined ? { position: result.position } : {}) });
    } else {
      setSendState({ phase: 'error', message: result.message });
    }
  };
  // On its way: the same comments must not also land in the message (or vanish from the tray); a failure frees them.
  const sending = sendState.phase === 'sending';
  const insert = (): void => {
    if (!insertIntoDraft || tooLong || !draftText || sending) return;
    insertIntoDraft(draftText);
    onTaken(ids);
    setInserted(true);
    setSendState({ phase: 'idle' });
  };

  if (!comments.length && !inserted && sendState.phase !== 'sent') return null;
  return (
    <section className="results-tray" aria-label={copy.comments(comments.length)} data-testid="review-comment-tray">
      {comments.length > 0 && (
        <>
          <ul className="results-tray__list">
            {comments.map((comment) => (
              <li key={comment.id} className="results-tray__item">
                <span className="results-tray__where">{comment.lines ? `${comment.path}:${comment.lines}` : comment.path}</span>
                {comment.text && <span className="results-tray__text">{comment.text}</span>}
                <IconButton size="sm" icon={glyphIcon('x')} aria-label={copy.removeComment} disabled={sending} onClick={() => onRemove(comment.id)} />
              </li>
            ))}
          </ul>
          <div className="results-tray__footer">
            {sendNow && (
              <Button variant="primary" size="sm" disabled={tooLong || sending} loading={sending} loadingLabel={copy.sending}
                onClick={() => void send()} title={copy.sendHint} data-testid="results-send-comments">
                {turnActive ? copy.sendQueued : copy.send}
              </Button>
            )}
            <Button variant={sendNow ? 'secondary' : 'primary'} size="sm" disabled={!insertIntoDraft || tooLong || sending} onClick={insert} title={copy.insertDraftHint}
              data-testid="results-insert-comments">
              {copy.insertDraft} · {copy.comments(comments.length)}
            </Button>
            <span className="results-tray__note">
              {tooLong ? copy.tooLong : !insertIntoDraft && !sendNow ? (draftUnavailable === 'history' ? copy.draftHistory : copy.draftDisabled) : sendNow ? copy.sendHint : copy.insertDraftHint}
            </span>
          </div>
          {sendState.phase === 'error' && (
            <p className="results-tray__error" role="alert" data-testid="results-send-error"><Glyph name="warn" /><span>{sendState.message ? copy.sendFailed(sendState.message) : copy.sendFailedPlain}</span></p>
          )}
        </>
      )}
      {sendState.phase === 'sent' && (
        <p className="results-tray__note" role="status" data-testid="results-send-status">
          {sendState.queued ? (sendState.position !== undefined ? copy.queuedAt(sendState.position) : copy.queuedPlain) : copy.sent}
        </p>
      )}
      {inserted && !comments.length && sendState.phase !== 'sent' && <p className="results-tray__note" role="status">{copy.insertedDraft}</p>}
    </section>
  );
}
