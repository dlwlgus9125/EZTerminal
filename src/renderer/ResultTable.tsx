import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { JsonValue, ResultRow } from '../shared/ipc';
import type { BlockController } from './block-controller';

// Virtualized, windowed table (T6). Only viewport-intersecting rows are in the
// DOM; the row data is fetched in windows from the interpreter's ResultStore via
// the credit/window controls (T5). TanStack Virtual drives WHICH rows render over
// the full row count; TanStack Table (headless) drives the column model + the
// header/cell rendering for the small loaded window.

const ROW_HEIGHT = 22;
const OVERSCAN = 8;
/** Rows fetched on each side of the visible range (the "small buffer"). */
const WINDOW_BUFFER = 20;
const VIEWPORT_HEIGHT = 360;

const EMPTY_ROW: ResultRow = Object.freeze({});

function formatCell(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function ResultTable({ controller }: { controller: BlockController }): JSX.Element {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { columns: schemaColumns, rowCount, version } = snapshot;

  const scrollRef = useRef<HTMLDivElement>(null);
  const didInitialFetch = useRef(false);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const firstVisible = virtualItems.length ? virtualItems[0].index : 0;
  const lastVisible = virtualItems.length ? virtualItems[virtualItems.length - 1].index : 0;
  const windowStart = Math.max(0, firstVisible - WINDOW_BUFFER);
  const windowEnd = Math.min(rowCount, lastVisible + 1 + WINDOW_BUFFER);

  // Fetch the visible window: explicit `requestRows` for the first page, then
  // `setViewport` (with read-ahead) as the user scrolls. The controller de-dupes.
  useEffect(() => {
    if (rowCount === 0) return;
    const count = windowEnd - windowStart;
    if (count <= 0) return;
    if (!didInitialFetch.current) {
      didInitialFetch.current = true;
      controller.requestRows(windowStart, count);
    } else {
      controller.setViewport(windowStart, count);
    }
  }, [controller, windowStart, windowEnd, rowCount]);

  // Small contiguous slice backing the table — never the whole result. `version`
  // is the external-store change signal: the row cache is mutable (not a React
  // value), so bumping version is what tells the memo to re-read it.
  const windowRows = useMemo(() => {
    const rows: ResultRow[] = [];
    for (let i = windowStart; i < windowEnd; i++) rows.push(controller.getRow(i) ?? EMPTY_ROW);
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, windowStart, windowEnd, version]);

  const columns = useMemo<ColumnDef<ResultRow>[]>(
    () =>
      schemaColumns.map((col) => ({
        accessorKey: col.name,
        header: col.name,
        cell: (info) => formatCell(info.getValue() as JsonValue | undefined),
      })),
    [schemaColumns],
  );

  const table = useReactTable({
    data: windowRows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const tableRows = table.getRowModel().rows;
  const headerGroup = table.getHeaderGroups()[0];

  return (
    <div className="result-table" data-testid="result-table">
      <div className="vt-header" role="row">
        {headerGroup?.headers.map((header) => (
          <div key={header.id} className="vt-cell vt-cell--head" role="columnheader" data-testid="table-header">
            {flexRender(header.column.columnDef.header, header.getContext())}
          </div>
        ))}
      </div>

      <div
        className="vt-scroll"
        data-testid="table-scroll"
        ref={scrollRef}
        style={{ height: VIEWPORT_HEIGHT, overflow: 'auto' }}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualItems.map((item) => {
            const globalIndex = item.index;
            const row = tableRows[globalIndex - windowStart];
            const loaded = controller.getRow(globalIndex) !== undefined;
            return (
              <div
                key={globalIndex}
                className="vt-row"
                role="row"
                data-testid="table-row"
                data-row-index={globalIndex}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: ROW_HEIGHT,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {loaded && row
                  ? row.getVisibleCells().map((cell) => (
                      <div key={cell.id} className="vt-cell" role="cell">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </div>
                    ))
                  : schemaColumns.map((col) => (
                      <div key={col.name} className="vt-cell vt-cell--loading" role="cell">
                        …
                      </div>
                    ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
