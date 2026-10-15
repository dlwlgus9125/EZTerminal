import { AlertTriangle, Bot, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Button } from '../ui';
import { useChatContext } from './ChatContext';
import { ChatRowView } from './ChatRowView';
import { ChatViewport } from './ChatViewport';
import { useChatCopy } from './copy';
import { FindBar } from './FindBar';
import { findRows } from './model/find';
import type { ChatModel } from './model/types';
import './chat.css';

export interface ChatTranscriptProps {
  readonly model: ChatModel;
  readonly providerLabel: string;
  readonly stateKey?: string;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onRetry?: () => void;
  readonly before?: ReactNode;
  readonly emptyLabel: string;
  readonly loadingLabel: string;
  readonly retryLabel: string;
  readonly onReachTop?: () => void;
  /** Older rows exist above; loads on the button or when the reader nears the top. */
  readonly earlier?: { readonly loading: boolean; readonly onLoad: () => void };
}

/** Conversation rows for one session in the active skin. Must render inside ChatProvider. */
export function ChatTranscript({
  model, providerLabel, stateKey, loading = false, error = null, onRetry, before, emptyLabel, loadingLabel, retryLabel, onReachTop, earlier,
}: ChatTranscriptProps): JSX.Element {
  const copy = useChatCopy();
  const { skin } = useChatContext();
  const rootRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [find, setFind] = useState<{ readonly query: string; readonly index: number; readonly seq: number }>();
  const query = find?.query;
  const seq = find?.seq;
  const matches = useMemo(() => (query === undefined ? [] : findRows(model.rows, query)), [query, model.rows]);
  const index = find && matches.length ? Math.min(find.index, matches.length - 1) : 0;
  const current = find ? matches[index] : undefined;
  const focusRow = useMemo(() => (current && seq !== undefined ? { id: current, seq } : undefined), [current, seq]);

  // Ctrl+F anywhere in this conversation panel (transcript or composer) opens find.
  useEffect(() => {
    const host = rootRef.current?.closest<HTMLElement>('.structured-agent') ?? rootRef.current;
    if (!host) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      setFind((open) => open ?? { query: '', index: 0, seq: 0 });
      requestAnimationFrame(() => {
        findInputRef.current?.focus();
        findInputRef.current?.select();
      });
    };
    host.addEventListener('keydown', onKeyDown);
    return () => host.removeEventListener('keydown', onKeyDown);
  }, []);

  const closeFind = (): void => {
    setFind(undefined);
    rootRef.current?.querySelector<HTMLElement>('.chat-viewport__scroll')?.focus();
  };
  const status = (
    <>
      {before}
      {earlier && (
        <div className="chat-earlier">
          <button type="button" className="chat-link-button" disabled={earlier.loading} onClick={earlier.onLoad} data-testid="chat-load-earlier">
            {earlier.loading ? <LoaderCircle className="chat-spin" aria-hidden="true" /> : null}
            {earlier.loading ? copy.loadingEarlier : copy.loadEarlier}
          </button>
        </div>
      )}
      {error && (
        <div className="structured-agent__banner structured-agent__banner--error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{error}</span>
          {onRetry && <Button variant="ghost" size="sm" onClick={onRetry}>{retryLabel}</Button>}
        </div>
      )}
      {loading && model.rows.length === 0 && (
        <p className="structured-agent-transcript__state" role="status">
          <LoaderCircle className="structured-agent__spinner" aria-hidden="true" />
          {loadingLabel}
        </p>
      )}
      {!loading && !error && model.rows.length === 0 && (
        <p className="structured-agent-transcript__state" data-testid="structured-agent-empty">
          <Bot aria-hidden="true" />
          {emptyLabel}
        </p>
      )}
    </>
  );
  return (
    <div ref={rootRef} className="chat-transcript" data-chat-skin={skin}>
      <ChatViewport
        rows={model.rows}
        stateKey={stateKey}
        label={copy.transcript}
        before={status}
        onReachTop={earlier ? () => { if (!earlier.loading) earlier.onLoad(); } : onReachTop}
        {...(find ? { highlight: find.query } : {})}
        {...(focusRow ? { focusRow } : {})}
        renderRow={(row) => <ChatRowView row={row} providerLabel={providerLabel} />}
      />
      {find && (
        <FindBar
          inputRef={findInputRef}
          query={find.query}
          index={index}
          count={matches.length}
          // A new query starts at the newest match, where the reader usually is.
          onQuery={(query) => setFind((open) => ({
            query, index: Math.max(0, findRows(model.rows, query).length - 1), seq: (open?.seq ?? 0) + 1,
          }))}
          onStep={(delta) => setFind((open) => open && matches.length
            ? { ...open, index: (index + delta + matches.length) % matches.length, seq: open.seq + 1 }
            : open)}
          onClose={closeFind}
        />
      )}
    </div>
  );
}
