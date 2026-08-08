import {
  Fragment,
  useRef,
  type Key,
  type MouseEventHandler,
  type ReactNode,
  type UIEventHandler,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

const DEFAULT_THRESHOLD = 200;

/** Window an unbounded action list while leaving small lists as ordinary DOM. */
export function VirtualizedRows<Item>({
  items,
  estimateSize,
  getKey,
  renderItem,
  className,
  testId,
  threshold = DEFAULT_THRESHOLD,
  onScroll,
  onContextMenu,
  children,
}: {
  readonly items: readonly Item[];
  readonly estimateSize: number;
  readonly getKey: (item: Item, index: number) => Key;
  readonly renderItem: (item: Item, index: number) => ReactNode;
  readonly className?: string;
  readonly testId?: string;
  readonly threshold?: number;
  readonly onScroll?: UIEventHandler<HTMLDivElement>;
  readonly onContextMenu?: MouseEventHandler<HTMLDivElement>;
  readonly children?: ReactNode;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const enabled = items.length > threshold;
  const virtualizer = useVirtualizer({
    count: items.length,
    enabled,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan: 10,
  });

  return (
    <div
      ref={scrollRef}
      className={className}
      data-testid={testId}
      data-virtualized={enabled || undefined}
      onScroll={onScroll}
      onContextMenu={onContextMenu}
    >
      {enabled ? (
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = items[virtualRow.index];
            if (item === undefined) return null;
            return (
              <div
                key={getKey(item, virtualRow.index)}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {renderItem(item, virtualRow.index)}
              </div>
            );
          })}
        </div>
      ) : items.map((item, index) => (
        <Fragment key={getKey(item, index)}>{renderItem(item, index)}</Fragment>
      ))}
      {children}
    </div>
  );
}
