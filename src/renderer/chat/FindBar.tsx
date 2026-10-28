import { Glyph } from '../ui/Glyph';
import type { RefObject } from 'react';

import { useChatCopy } from './copy';

/** Find-in-conversation field: Enter / Shift+Enter step through matching rows, Esc closes. */
export function FindBar({ inputRef, query, index, count, onQuery, onStep, onClose }: {
  readonly inputRef: RefObject<HTMLInputElement>;
  readonly query: string;
  /** Zero-based current match. */
  readonly index: number;
  readonly count: number;
  readonly onQuery: (query: string) => void;
  readonly onStep: (delta: 1 | -1) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const copy = useChatCopy();
  return (
    <div className="chat-find" role="search" data-testid="chat-find">
      <Glyph name="search" className="chat-find__icon" />
      <input
        ref={inputRef}
        className="chat-find__input"
        type="text"
        value={query}
        placeholder={copy.find}
        aria-label={copy.find}
        spellCheck={false}
        onChange={(event) => onQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            onStep(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      />
      <span className="chat-find__count" role="status">
        {query.trim() ? (count ? copy.findCount(index + 1, count) : copy.findNone) : ''}
      </span>
      <button type="button" className="chat-icon-action" aria-label={copy.findPrevious} title={copy.findPrevious} disabled={!count} onClick={() => onStep(-1)}>
        <Glyph name="up" />
      </button>
      <button type="button" className="chat-icon-action" aria-label={copy.findNext} title={copy.findNext} disabled={!count} onClick={() => onStep(1)}>
        <Glyph name="down" />
      </button>
      <button type="button" className="chat-icon-action" aria-label={copy.findClose} title={copy.findClose} onClick={onClose}>
        <Glyph name="x" />
      </button>
    </div>
  );
}
