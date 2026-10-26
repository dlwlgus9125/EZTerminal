import { LoaderCircle, RotateCcw, Square, ArrowUp, Trash2, X } from 'lucide-react';
import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

import { chatCopy, useChatLocale } from '../chat/copy';
import { ChatMarkdown, type ChatMarkdownLabels } from '../chat/markdown/ChatMarkdown';
import { ConversationReviewOverlayContext } from '../conversation-review-overlay';
import { Button, Dialog } from '../ui';
import { sideQuestionCopy, type SideQuestionCopy } from './copy';
import type { SideQuestionThread } from './use-side-question-thread';
import './side-question.css';

export interface SideQuestionSurfaceProps {
  readonly variant: 'desktop' | 'mobile';
  readonly ko: boolean;
  readonly thread: SideQuestionThread;
  readonly onClose: () => void;
  /** Why a new question cannot be asked now; earlier answers stay readable. */
  readonly disabledReason?: string;
  readonly returnFocusRef: RefObject<HTMLButtonElement>;
  readonly id: string;
}

const MIN_WIDTH = 288;
const MIN_HEIGHT = 224;
const STEP = 8;

/** The /btw thread: question bubbles, answers, and its own input. Shared by both forms. */
function SideQuestionThreadView({ thread, copy, disabledReason, inputRef }: {
  readonly thread: SideQuestionThread;
  readonly copy: SideQuestionCopy;
  readonly disabledReason?: string;
  readonly inputRef: RefObject<HTMLTextAreaElement>;
}): JSX.Element {
  const chat = chatCopy(useChatLocale());
  const labels = useMemo<Partial<ChatMarkdownLabels>>(() => ({
    copyCode: chat.copyCode, copied: chat.copied, copyFailed: chat.copyFailed,
    wrapLines: chat.wrapLines, task: chat.task, blockedImage: chat.blockedImage,
  }), [chat]);
  const [text, setText] = useState('');
  const composing = useRef(false);
  const listRef = useRef<HTMLOListElement>(null);
  const reasonId = useId();
  const last = thread.entries.at(-1);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [thread.entries.length, last?.status]);
  const submit = (): void => {
    if (disabledReason || thread.pending) return;
    if (thread.ask(text)) setText('');
  };
  const status = last?.status === 'pending' ? copy.pending
    : last?.status === 'failed' && last.errorCode ? copy.errors[last.errorCode]
      : last?.status === 'answered' ? (last.answer ?? copy.noAnswer).slice(0, 200) : '';
  return (
    <>
      {/* A focusable scroll region: the Android sheet lands here (not the input), so the keyboard does not cover the answers. */}
      <ol ref={listRef} className="side-question__thread" tabIndex={0} aria-label={copy.threadLabel} data-testid="side-question-thread">
        {thread.entries.length === 0 && <li className="side-question__empty">{copy.empty}</li>}
        {thread.entries.map((entry) => (
          <li key={entry.id} className="side-question__exchange" data-status={entry.status}>
            <div className="side-question__question">
              <span className="side-question__who">{copy.you}</span>
              <p>{entry.question}</p>
            </div>
            {entry.status === 'pending' && (
              <p className="side-question__pending"><LoaderCircle className="chat-spin" aria-hidden="true" />{copy.pending}</p>
            )}
            {entry.status === 'answered' && (entry.answer
              ? <div className="side-question__answer chat-assistant" data-synthetic={entry.synthetic || undefined}>
                <ChatMarkdown markdown={entry.answer} variant="prose" labels={labels} />
                {entry.fallbackNotice && <p className="side-question__note">{entry.fallbackNotice}</p>}
              </div>
              : <p className="side-question__note">{copy.noAnswer}</p>)}
            {entry.status === 'failed' && (
              <div className="side-question__error" role={entry.errorCode === 'cancelled' ? undefined : 'alert'}>
                <p>{copy.errors[entry.errorCode ?? 'failed']}</p>
                {entry.errorCode !== 'cancelled' && entry.errorCode !== 'invalid' && !disabledReason && !thread.pending && (
                  <Button type="button" variant="ghost" size="sm" leadingIcon={<RotateCcw />} onClick={() => thread.ask(entry.question)}>{copy.retry}</Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
      <span className="ez-ui-visually-hidden" aria-live="polite">{status}</span>
      <form className="side-question__composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <textarea
          ref={inputRef}
          value={text}
          rows={2}
          maxLength={4000}
          placeholder={copy.placeholder}
          aria-label={copy.inputLabel}
          aria-describedby={disabledReason ? reasonId : undefined}
          disabled={Boolean(disabledReason)}
          onChange={(event) => setText(event.currentTarget.value)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          data-testid="side-question-input"
        />
        {thread.pending ? (
          <button type="button" className="chat-composer__send" data-kind="stop" aria-label={copy.stop} title={copy.stop} onClick={thread.cancel} data-testid="side-question-stop">
            <Square aria-hidden="true" />
          </button>
        ) : (
          <button type="submit" className="chat-composer__send" disabled={Boolean(disabledReason) || !text.trim()} aria-label={copy.send} title={copy.send} data-testid="side-question-send">
            <ArrowUp aria-hidden="true" />
          </button>
        )}
      </form>
      {disabledReason && <p id={reasonId} className="side-question__reason" role="status">{disabledReason}</p>}
    </>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Desktop: a non-modal window floating up from the message box, smaller than the conversation,
 * resizable from its top and left edges (pointer or arrow keys). The conversation stays usable.
 */
function SideQuestionWindow({ ko, thread, onClose, disabledReason, returnFocusRef, id }: Omit<SideQuestionSurfaceProps, 'variant'>): JSX.Element {
  const copy = sideQuestionCopy(ko);
  const titleId = useId();
  const windowRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [bounds, setBounds] = useState({ maxWidth: 640, maxHeight: 480 });
  const [size, setSize] = useState({ width: 420, height: 380 });
  useLayoutEffect(() => {
    const host = windowRef.current?.closest('.structured-agent');
    // The anchor spans the message box's column; the window never leaves it.
    const column = windowRef.current?.parentElement;
    const measure = (): void => {
      if (!host) return;
      const columnWidth = column?.clientWidth || host.clientWidth;
      setBounds({ maxWidth: Math.round(Math.min(host.clientWidth * 0.7, columnWidth)), maxHeight: Math.round(host.clientHeight * 0.75) });
    };
    measure();
    const View = windowRef.current?.ownerDocument.defaultView;
    if (!host || !View?.ResizeObserver) return undefined;
    const observer = new View.ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  const width = clamp(size.width, MIN_WIDTH, bounds.maxWidth);
  const height = clamp(size.height, MIN_HEIGHT, bounds.maxHeight);
  useEffect(() => {
    inputRef.current?.focus();
    const returnTo = returnFocusRef.current;
    const panel = windowRef.current?.closest('.structured-agent');
    return () => {
      const target = returnTo?.isConnected ? returnTo
        : panel?.querySelector<HTMLElement>('[data-testid="structured-agent-composer-input"]');
      target?.focus();
    };
    // Focus moves in once on open and back once on close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const drag = (axis: 'width' | 'height') => (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY, width, height };
    const move = (next: PointerEvent): void => {
      setSize((current) => axis === 'width'
        ? { ...current, width: clamp(start.width + (start.x - next.clientX), MIN_WIDTH, bounds.maxWidth) }
        : { ...current, height: clamp(start.height + (start.y - next.clientY), MIN_HEIGHT, bounds.maxHeight) });
    };
    const end = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };
  const nudge = (axis: 'width' | 'height') => (event: KeyboardEvent<HTMLDivElement>): void => {
    const grow = axis === 'width' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
    const shrink = axis === 'width' ? event.key === 'ArrowRight' : event.key === 'ArrowDown';
    if (!grow && !shrink) return;
    event.preventDefault();
    const delta = grow ? STEP : -STEP;
    setSize((current) => axis === 'width'
      ? { ...current, width: clamp(width + delta, MIN_WIDTH, bounds.maxWidth) }
      : { ...current, height: clamp(height + delta, MIN_HEIGHT, bounds.maxHeight) });
  };

  return (
    <section
      ref={windowRef}
      id={id}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className="side-question"
      style={{ width: `${width}px`, height: `${height}px` }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      data-testid="side-question-window"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={copy.resizeWidth}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={Math.max(MIN_WIDTH, bounds.maxWidth)}
        aria-valuenow={width}
        tabIndex={0}
        className="side-question__grip side-question__grip--width"
        onPointerDown={drag('width')}
        onKeyDown={nudge('width')}
        data-testid="side-question-resize-width"
      />
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={copy.resizeHeight}
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={Math.max(MIN_HEIGHT, bounds.maxHeight)}
        aria-valuenow={height}
        tabIndex={0}
        className="side-question__grip side-question__grip--height"
        onPointerDown={drag('height')}
        onKeyDown={nudge('height')}
        data-testid="side-question-resize-height"
      />
      <header className="side-question__header">
        <div className="side-question__heading">
          <h2 id={titleId}>{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
        <button type="button" className="chat-icon-action" aria-label={copy.clear} title={copy.clear}
          disabled={thread.entries.length === 0} onClick={thread.clear} data-testid="side-question-clear">
          <Trash2 aria-hidden="true" />
        </button>
        <button type="button" className="chat-icon-action" aria-label={copy.close} title={`${copy.close} (Esc)`} onClick={onClose} data-testid="side-question-close">
          <X aria-hidden="true" />
        </button>
      </header>
      <SideQuestionThreadView thread={thread} copy={copy} disabledReason={disabledReason} inputRef={inputRef} />
    </section>
  );
}

/** Android: the same thread in the host's bottom sheet (modal, closed with Back). */
function SideQuestionSheet({ ko, thread, onClose, disabledReason, returnFocusRef }: Omit<SideQuestionSurfaceProps, 'variant'>): JSX.Element {
  const copy = sideQuestionCopy(ko);
  const HostOverlay = useContext(ConversationReviewOverlayContext);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const content = (
    <div className="side-question side-question--sheet" data-testid="side-question-sheet">
      <p className="side-question__subtitle">{copy.subtitle}</p>
      <SideQuestionThreadView thread={thread} copy={copy} disabledReason={disabledReason} inputRef={inputRef} />
      {thread.entries.length > 0 && (
        <Button type="button" variant="ghost" size="sm" leadingIcon={<Trash2 />} onClick={thread.clear} data-testid="side-question-clear">{copy.clear}</Button>
      )}
    </div>
  );
  if (HostOverlay) return <HostOverlay title={copy.title} onClose={onClose} returnFocusRef={returnFocusRef}>{content}</HostOverlay>;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title={copy.title} variant="sheet" closeLabel={copy.close}>
      {content}
    </Dialog>
  );
}

export function SideQuestionSurface({ variant, ...props }: SideQuestionSurfaceProps): JSX.Element {
  return variant === 'mobile' ? <SideQuestionSheet {...props} /> : <SideQuestionWindow {...props} />;
}
