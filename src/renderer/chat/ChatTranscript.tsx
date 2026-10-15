import { AlertTriangle, Bot, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '../ui';
import { useChatContext } from './ChatContext';
import { ChatRowView } from './ChatRowView';
import { ChatViewport } from './ChatViewport';
import { useChatCopy } from './copy';
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
}

/** Conversation rows for one session in the active skin. Must render inside ChatProvider. */
export function ChatTranscript({
  model, providerLabel, stateKey, loading = false, error = null, onRetry, before, emptyLabel, loadingLabel, retryLabel, onReachTop,
}: ChatTranscriptProps): JSX.Element {
  const copy = useChatCopy();
  const { skin } = useChatContext();
  const status = (
    <>
      {before}
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
    <div className="chat-transcript" data-chat-skin={skin}>
      <ChatViewport
        rows={model.rows}
        stateKey={stateKey}
        label={copy.transcript}
        before={status}
        onReachTop={onReachTop}
        renderRow={(row) => <ChatRowView row={row} providerLabel={providerLabel} />}
      />
    </div>
  );
}
