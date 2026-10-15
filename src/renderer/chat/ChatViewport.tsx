import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { readSessionViewState, saveSessionViewState } from '../session-view-state';
import { useChatCopy } from './copy';
import type { ChatRow } from './model/types';

/** Conversations shorter than this render every row; longer ones virtualize. */
export const VIRTUALIZE_ABOVE = 120;
const FOLLOW_THRESHOLD_PX = 64;

interface SavedAnchor {
  readonly rowId: string;
  readonly offset: number;
  readonly follow: boolean;
}

function estimate(row: ChatRow | undefined): number {
  switch (row?.kind) {
    case 'user': return 72;
    case 'assistant': return Math.min(600, 48 + Math.ceil(row.text.length / 90) * 22);
    case 'activity': return 40;
    case 'turn-status': return 24;
    case 'plan': return 240;
    case 'changes': return 96;
    default: return 36;
  }
}

/**
 * Scroll container for chat rows: follows the tail while the reader is at the
 * bottom (also when rows grow after async highlighting or expansion), offers a
 * jump-to-latest pill and a "New" divider when content arrives while scrolled
 * up, and restores the reader's position by row id after remounts.
 */
/** A running turn's status trails its rows instead of heading them. */
function liveStatus(row: ChatRow): '' | undefined {
  return row.kind === 'turn-status' && !row.finishedAt ? '' : undefined;
}

export function ChatViewport({ rows, renderRow, stateKey, before, after, onReachTop, testId = 'structured-agent-transcript', label }: {
  readonly rows: readonly ChatRow[];
  readonly renderRow: (row: ChatRow) => ReactNode;
  readonly stateKey?: string;
  readonly before?: ReactNode;
  readonly after?: ReactNode;
  /** Called when the reader scrolls near the top (load earlier messages). */
  readonly onReachTop?: () => void;
  readonly testId?: string;
  readonly label: string;
}): JSX.Element {
  const copy = useChatCopy();
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorKey = stateKey ? `${stateKey}:chat-anchor` : undefined;
  const saved = useRef<SavedAnchor | undefined>(anchorKey ? readSessionViewState<SavedAnchor>(anchorKey) : undefined);
  const following = useRef(saved.current?.follow ?? true);
  const [atBottom, setAtBottom] = useState(true);
  const [newFrom, setNewFrom] = useState<string | undefined>();
  const seenCount = useRef(rows.length);
  const virtual = rows.length > VIRTUALIZE_ABOVE;
  const listRef = useRef<HTMLOListElement>(null);
  const [listOffset, setListOffset] = useState(0);
  useLayoutEffect(() => {
    if (virtual && listRef.current) setListOffset(listRef.current.offsetTop);
  }, [virtual, before]);

  const virtualizer = useVirtualizer({
    scrollMargin: listOffset,
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimate(rows[index]),
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 8,
  });

  const scrollToEnd = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (virtual) virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
    element.scrollTop = element.scrollHeight;
  }, [rows.length, virtual, virtualizer]);

  // Restore the saved reading position once, by row id.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const anchor = saved.current;
    if (!element || !anchor || anchor.follow) return;
    const index = rows.findIndex((row) => row.id === anchor.rowId);
    if (index < 0) return;
    saved.current = undefined;
    if (virtual) {
      virtualizer.scrollToIndex(index, { align: 'start' });
    } else {
      const target = element.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(anchor.rowId)}"]`);
      if (target) element.scrollTop = target.offsetTop - anchor.offset;
    }
  }, [rows, virtual, virtualizer]);

  // New rows: follow, or mark where unseen content starts.
  useEffect(() => {
    if (rows.length > seenCount.current && !following.current && !newFrom) setNewFrom(rows[seenCount.current]?.id);
    if (following.current) {
      seenCount.current = rows.length;
      scrollToEnd();
    }
  }, [rows, newFrom, scrollToEnd]);

  // Content that grows after layout (highlighting, expansion, streaming) keeps the tail pinned.
  useEffect(() => {
    const element = scrollRef.current;
    const content = element?.firstElementChild;
    if (!element || !content || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => { if (following.current) element.scrollTop = element.scrollHeight; });
    observer.observe(content);
    return () => observer.disconnect();
  }, [virtual]);

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD_PX;
    following.current = bottom;
    setAtBottom(bottom);
    if (bottom) {
      seenCount.current = rows.length;
      if (newFrom) setNewFrom(undefined);
    }
    if (element.scrollTop < 200) onReachTop?.();
    if (!anchorKey) return;
    const top = element.scrollTop;
    const first = [...element.querySelectorAll<HTMLElement>('[data-row-id]')].find((node) => node.offsetTop + node.offsetHeight > top);
    if (first) saveSessionViewState<SavedAnchor>(anchorKey, { rowId: first.dataset.rowId!, offset: first.offsetTop - top, follow: bottom });
  };

  const rowNode = (row: ChatRow): ReactNode => (
    <>
      {row.id === newFrom && <div className="chat-new-divider" role="separator" aria-label={copy.newMessages}><span>{copy.newMessages}</span></div>}
      {renderRow(row)}
    </>
  );

  return (
    <div className="chat-viewport" data-testid={testId}>
      <div ref={scrollRef} className="chat-viewport__scroll" onScroll={onScroll} tabIndex={-1}>
        {virtual ? (
          <div className="chat-viewport__content">
            {before}
            <ol ref={listRef} className="chat-rows" data-virtual="" aria-label={label} style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index]!;
                return (
                  <li key={item.key} ref={virtualizer.measureElement} data-index={item.index} data-row-id={row.id} data-kind={row.kind} data-live={liveStatus(row)}
                    className="chat-row" style={{ transform: `translateY(${item.start - listOffset}px)` }}>
                    {rowNode(row)}
                  </li>
                );
              })}
            </ol>
            {after}
          </div>
        ) : (
          <div className="chat-viewport__content">
            {before}
            <ol className="chat-rows" aria-label={label}>
              {rows.map((row) => <li key={row.id} data-row-id={row.id} data-kind={row.kind} data-live={liveStatus(row)} className="chat-row">{rowNode(row)}</li>)}
            </ol>
            {after}
          </div>
        )}
      </div>
      {!atBottom && (
        <button type="button" className="chat-jump" onClick={() => { following.current = true; setNewFrom(undefined); scrollToEnd(); }}>
          <ArrowDown aria-hidden="true" />
          <span>{newFrom ? copy.newMessages : copy.jumpToLatest}</span>
        </button>
      )}
    </div>
  );
}
