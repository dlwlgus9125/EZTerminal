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

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

/**
 * Find matches of every mounted viewport, painted as `::highlight(chat-find)`;
 * matches inside the current row also as `::highlight(chat-find-current)`.
 */
const findRanges = new Map<symbol, { readonly all: Range[]; readonly current: Range[] }>();

function paintFindHighlight(): void {
  const registry = (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights;
  const HighlightType = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry || !HighlightType) return;
  for (const [name, ranges] of [
    ['chat-find', [...findRanges.values()].flatMap((entry) => entry.all)],
    ['chat-find-current', [...findRanges.values()].flatMap((entry) => entry.current)],
  ] as const) {
    if (!ranges.length) {
      registry.delete(name);
      continue;
    }
    const highlight = new HighlightType(...ranges) as { priority?: number };
    // The current row's matches paint over the others.
    if (name === 'chat-find-current') highlight.priority = 1;
    registry.set(name, highlight);
  }
}

function matchRanges(root: Element, needle: string, limit = 2_000): Range[] {
  const ranges: Range[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && ranges.length < limit; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').toLocaleLowerCase();
    for (let at = text.indexOf(needle); at >= 0 && ranges.length < limit; at = text.indexOf(needle, at + needle.length)) {
      const range = root.ownerDocument.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
}

/** A running turn's status trails its rows instead of heading them. */
function liveStatus(row: ChatRow): '' | undefined {
  return row.kind === 'turn-status' && !row.finishedAt ? '' : undefined;
}

/**
 * Scroll container for chat rows: follows the tail while the reader is at the
 * bottom (also when rows grow after async highlighting or expansion), offers a
 * jump-to-latest pill and a "New" divider when content arrives while scrolled
 * up, and restores the reader's position by row id after remounts.
 */
export function ChatViewport({
  rows, renderRow, stateKey, before, after, onReachTop, testId = 'structured-agent-transcript', label, highlight, focusRow,
}: {
  readonly rows: readonly ChatRow[];
  readonly renderRow: (row: ChatRow) => ReactNode;
  readonly stateKey?: string;
  readonly before?: ReactNode;
  readonly after?: ReactNode;
  /** Called when the reader scrolls near the top (load earlier messages). */
  readonly onReachTop?: () => void;
  readonly testId?: string;
  readonly label: string;
  /** Find-in-chat query; matches in mounted rows are highlighted. */
  readonly highlight?: string;
  /** Row to bring into view and mark as the current find match; `seq` re-triggers the same row. */
  readonly focusRow?: { readonly id: string; readonly seq: number };
}): JSX.Element {
  const copy = useChatCopy();
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorKey = stateKey ? `${stateKey}:chat-anchor` : undefined;
  const saved = useRef<SavedAnchor | undefined>(anchorKey ? readSessionViewState<SavedAnchor>(anchorKey) : undefined);
  const following = useRef(saved.current?.follow ?? true);
  const [atBottom, setAtBottom] = useState(true);
  const [newFrom, setNewFrom] = useState<string | undefined>();
  /** Rows the reader has had at the bottom of the view; anything else that arrives later is "new". */
  const seenIds = useRef(new Set(rows.map((row) => row.id)));
  const mountedAt = useRef(new Date().toISOString());
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

  // New rows: follow, or mark where unseen content starts. Rows of the initial
  // load, earlier pages loaded above, and rows that only moved are not "new".
  useEffect(() => {
    const seen = seenIds.current;
    if (following.current || seen.size === 0) {
      for (const row of rows) seen.add(row.id);
      if (following.current) scrollToEnd();
      return;
    }
    if (newFrom) return;
    const firstSeen = rows.findIndex((row) => seen.has(row.id));
    const unseen = rows.find((row, index) => index > firstSeen && !seen.has(row.id) && row.createdAt >= mountedAt.current);
    if (firstSeen >= 0 && unseen) setNewFrom(unseen.id);
  }, [rows, newFrom, scrollToEnd]);

  // Content that grows after layout (highlighting, expansion, streaming) keeps the tail pinned,
  // and so does a panel that gets shorter (an approval dock or child track opening below).
  useEffect(() => {
    const element = scrollRef.current;
    const content = element?.firstElementChild;
    if (!element || !content || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => { if (following.current) element.scrollTop = element.scrollHeight; });
    observer.observe(content);
    observer.observe(element);
    return () => observer.disconnect();
  }, [virtual]);

  // Find: scroll the current match into view without leaving follow mode on.
  useLayoutEffect(() => {
    if (!focusRow) return;
    const index = rows.findIndex((row) => row.id === focusRow.id);
    if (index < 0) return;
    following.current = false;
    if (virtual) {
      virtualizer.scrollToIndex(index, { align: 'center' });
    } else {
      scrollRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(focusRow.id)}"]`)?.scrollIntoView({ block: 'center' });
    }
    // Only a new target (or a repeat request) scrolls; row updates do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRow]);

  // Find: highlight matches in whatever rows are mounted, repainting as rows mount or change.
  useEffect(() => {
    const element = scrollRef.current;
    const needle = highlight?.trim().toLocaleLowerCase();
    if (!element || !needle || typeof MutationObserver === 'undefined') return undefined;
    const key = Symbol('chat-find');
    let frame = 0;
    const paint = (): void => {
      const list = element.querySelector('.chat-rows');
      const all = list ? matchRanges(list, needle) : [];
      const currentRow = list?.querySelector('[data-find-current]');
      findRanges.set(key, { all, current: currentRow ? all.filter((range) => currentRow.contains(range.startContainer)) : [] });
      paintFindHighlight();
    };
    const schedule = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paint);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(element, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-find-current'] });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      findRanges.delete(key);
      paintFindHighlight();
    };
  }, [highlight]);

  // Rows loaded above (earlier messages) must not move what the reader is looking at.
  const firstRowId = rows[0]?.id;
  const previous = useRef<{ readonly firstRowId?: string; readonly height: number; readonly top: number }>({ height: 0, top: 0 });
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const before = previous.current;
    if (before.firstRowId && firstRowId !== before.firstRowId && !following.current
      && rows.some((row) => row.id === before.firstRowId)) {
      element.scrollTop = before.top + (element.scrollHeight - before.height);
    }
    previous.current = { firstRowId, height: element.scrollHeight, top: element.scrollTop };
  });

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    const movedUp = element.scrollTop < previous.current.top - 1;
    previous.current = { ...previous.current, height: element.scrollHeight, top: element.scrollTop };
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD_PX;
    // Only the reader moving up leaves the tail; rows growing below (measurement,
    // highlighting) also fire scroll events and must not stop following.
    if (bottom) following.current = true;
    else if (movedUp) following.current = false;
    setAtBottom(following.current);
    if (bottom) {
      for (const row of rows) seenIds.current.add(row.id);
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
                    data-find-current={row.id === focusRow?.id ? '' : undefined}
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
              {rows.map((row) => <li key={row.id} data-row-id={row.id} data-kind={row.kind} data-live={liveStatus(row)}
                data-find-current={row.id === focusRow?.id ? '' : undefined} className="chat-row">{rowNode(row)}</li>)}
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
