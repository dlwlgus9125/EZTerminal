/**
 * Disk-backed, credit-driven result retention for one structured command block.
 *
 * Rows are still pulled only to the requested credit target, but accepted rows
 * are encoded into bounded segments beneath a random, user-temp runtime
 * directory. POSIX permissions are owner-only; Windows inherits the current
 * user's temp-directory ACL (see the documented residual platform risk).
 * At most a small LRU of decoded segments remains hot; arbitrary historical
 * windows are read back from disk without placing the complete result in memory.
 */

import { randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ResultRow } from '../shared/ipc';
import {
  DEFAULT_OUTPUT_RETENTION_LIMITS,
  getDefaultOutputRetentionRuntime,
  type OutputRetentionLimits,
  type OutputRetentionRuntime,
} from './output-retention-runtime';

/** A malformed renderer request must not force an oversized IPC frame. */
const MAX_WINDOW = 10_000;
const RECORD_HEADER_BYTES = 4;
const HOT_RESERVATION_CREDIT_BYTES = 1024 * 1024;

interface Segment {
  readonly start: number;
  readonly count: number;
  readonly bytes: number;
  /** Conservative decoded V8 heap estimate used for hot quota accounting. */
  readonly hotBytes: number;
  readonly path: string;
  readonly cacheKey: string;
  cachedRows?: readonly ResultRow[];
  loading?: Promise<readonly ResultRow[]>;
}

interface EncodedRecord {
  readonly json: string;
  /** Four-byte spill-record framing allowance plus UTF-8 JSON payload. */
  readonly byteLength: number;
  readonly decodedHotBytes: number;
  /** Decoded row plus its pending JSON builder string. */
  readonly retainedHotBytes: number;
}

export interface ResultStoreOptions<SourceRow = ResultRow> {
  readonly runtime?: OutputRetentionRuntime;
  readonly limits?: Partial<OutputRetentionLimits>;
  /** Optional synchronous wire-row projection, fused with the source pull. */
  readonly mapRow?: (row: SourceRow) => ResultRow;
  /**
   * Global producer stop seam (for example, an owning block's AbortSignal).
   * Checked around every iterator pull so a large target cannot hide abort.
   */
  readonly shouldStopPull?: () => boolean;
  /** Narrow storage seam for deterministic failure-path tests. */
  readonly fileSystem?: Partial<ResultStoreFileSystem>;
}

export interface ResultStoreFileSystem {
  readonly randomBytes: (size: number) => Buffer;
  readonly writeFile: (
    path: string,
    contents: Buffer,
    options: { readonly flag: 'wx'; readonly mode: number },
  ) => Promise<void>;
  readonly remove: (
    path: string,
    options: { readonly recursive?: boolean; readonly force: boolean },
  ) => Promise<void>;
}

export interface ResultStoreDiagnostics {
  readonly hotBytes: number;
  readonly spillBytes: number;
  readonly segments: number;
  readonly hotReservationCalls: number;
  readonly segmentWrites: number;
  readonly runDirectory: string;
}

export interface ResultWindow {
  readonly start: number;
  readonly rows: ResultRow[];
}

/** Stable error kind consumed by the existing block error-frame path. */
export class OutputCapacityError extends Error {
  readonly code = 'capacity' as const;

  constructor(message: string) {
    super(`[capacity] ${message}`);
    this.name = 'OutputCapacityError';
  }
}

export class ResultStore<SourceRow = ResultRow> {
  private readonly runtime: OutputRetentionRuntime;
  private readonly limits: OutputRetentionLimits;
  private readonly runDirectory: string;
  private readonly mapRow: (row: SourceRow) => ResultRow;
  private readonly shouldStopPull: () => boolean;
  private readonly fileSystem: ResultStoreFileSystem;
  private readonly segments: Segment[] = [];
  private readonly cacheLru = new Map<string, Segment>();

  private pendingRows: ResultRow[] = [];
  private pendingRecords: EncodedRecord[] = [];
  private pendingBytes = 0;
  private pendingHotBytes = 0;
  private pendingDecodedHotBytes = 0;
  private totalRows = 0;
  private hotBytes = 0;
  /** Globally reserved but not yet consumed builder credit. */
  private hotCreditBytes = 0;
  private spillBytes = 0;
  private hotReservationCalls = 0;
  private segmentWrites = 0;

  private done = false;
  private sourceStopped = false;
  private disposed = false;
  private failure: Error | null = null;
  private disposePromise: Promise<void> | null = null;
  /** Serializes source pulls: the single iterator is advanced one call at a time. */
  private advanceChain: Promise<void> = Promise.resolve();
  private readonly activeWindowReads = new Set<Promise<unknown>>();

  constructor(
    private readonly iterator: AsyncIterator<SourceRow>,
    options: ResultStoreOptions<SourceRow> = {},
  ) {
    this.runtime = options.runtime ?? getDefaultOutputRetentionRuntime();
    this.limits = validateLimits({
      ...DEFAULT_OUTPUT_RETENTION_LIMITS,
      ...options.limits,
      // Global quotas belong to the shared runtime, never to one store.
      globalHotBytes: this.runtime.globalHotLimit,
      globalSpillBytes: this.runtime.globalSpillLimit,
    });
    this.runDirectory = this.runtime.createRunDirectory();
    this.mapRow = options.mapRow ?? ((row) => row as unknown as ResultRow);
    this.shouldStopPull = options.shouldStopPull ?? (() => false);
    this.fileSystem = {
      randomBytes,
      writeFile: (path, contents, writeOptions) => writeFile(path, contents, writeOptions),
      remove: (path, removeOptions) => rm(path, removeOptions),
      ...options.fileSystem,
    };
  }

  /** Rows accepted so far (the running total while filling). */
  get count(): number {
    return this.totalRows;
  }

  /** True once the source has ended, been stopped, or hit a capacity failure. */
  get exhausted(): boolean {
    return this.done;
  }

  /**
   * Synchronous compatibility accessor. Hot rows avoid I/O; a cold row performs
   * a bounded synchronous segment read. Production uses this only for row zero
   * during schema inference, immediately after `ensure(1)`.
   */
  at(index: number): ResultRow | undefined {
    const safeIndex = Math.trunc(index);
    if (safeIndex < 0 || safeIndex >= this.totalRows) return undefined;
    const pendingStart = this.totalRows - this.pendingRows.length;
    if (safeIndex >= pendingStart) return this.pendingRows[safeIndex - pendingStart];
    const segment = this.findSegment(safeIndex);
    if (!segment) return undefined;
    const rows = segment.cachedRows ?? decodeSegment(readFileSync(segment.path), segment);
    if (!segment.cachedRows) this.tryCacheSegment(segment, rows);
    return rows[safeIndex - segment.start];
  }

  /**
   * Advance the source until at least `target` rows are retained, or until a
   * terminal condition. Pulls and segment writes remain strictly serialized.
   */
  ensure(target: number, shouldPause?: () => boolean): Promise<void> {
    const safeTarget = nonNegativeSafeInteger(target, 'result target');
    if (
      safeTarget <= this.totalRows
      || this.disposed
      || this.shouldStopPull()
      || (this.done && !this.failure)
    ) {
      return Promise.resolve();
    }
    if (this.failure) return Promise.reject(this.failure);

    const run = this.advanceChain.then(() => this.advanceUntil(safeTarget, shouldPause));
    this.advanceChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async advanceUntil(target: number, shouldPause?: () => boolean): Promise<void> {
    if (
      target <= this.totalRows
      || this.disposed
      || this.shouldStopPull()
      || (this.done && !this.failure)
    ) return;
    if (this.failure) throw this.failure;

    try {
      while (!this.done && !this.disposed && this.totalRows < target) {
        if (this.shouldStopPull() || shouldPause?.()) return;
        const next = await this.iterator.next();
        if (this.disposed || this.done || this.shouldStopPull()) return;
        if (next.done) {
          this.done = true;
          this.releaseUnusedHotCredit();
          break;
        }
        const pendingAppend = this.append(this.mapRow(next.value));
        if (pendingAppend) await pendingAppend;
      }
    } catch (error) {
      const retainedError = asError(error);
      // Rows whose disk reservation already succeeded remain available.
      try {
        await this.flushPending(true);
      } catch (flushError) {
        this.failure = asError(flushError);
      }
      this.failure ??= retainedError;
      this.done = true;
      this.releaseUnusedHotCredit();
      await this.stopIterator().catch(() => undefined);
      throw this.failure;
    }
  }

  /**
   * Retain one row synchronously while the active segment still has room.
   * Only segment boundaries and the direct-cold fallback return a promise.
   * Keeping the common path synchronous avoids adding a second microtask hop
   * to every source pull (100,000 avoidable awaits for `gen-rows 100000`).
  */
  private append(row: ResultRow): Promise<void> | undefined {
    const record = encodeRow(row);
    if (record.byteLength > this.limits.segmentBytes) {
      throw new OutputCapacityError(
        `one row requires ${record.byteLength} bytes; the per-segment limit is ${this.limits.segmentBytes} bytes`,
      );
    }

    if (
      this.pendingRows.length >= this.limits.segmentRows
      || this.pendingBytes + record.byteLength > this.limits.segmentBytes
    ) {
      return this.flushAndAppend(row, record, true);
    }

    return this.appendEncoded(row, record);
  }

  private appendEncoded(
    row: ResultRow,
    record: EncodedRecord,
  ): Promise<void> | undefined {
    const { decodedHotBytes, retainedHotBytes } = record;
    const reservedHot = this.reserveBuilderHot(retainedHotBytes);
    if (!reservedHot && this.pendingRows.length > 0) {
      // Active builders are not globally evictable. Persist ours without a hot
      // copy, then retry before falling back to a direct cold segment.
      return this.flushAndAppend(row, record, false);
    }

    if (!reservedHot) {
      return this.writeDirectAndCount(row, record);
    }

    this.hotBytes += retainedHotBytes;
    this.pendingRows.push(row);
    this.pendingRecords.push(record);
    this.pendingBytes += record.byteLength;
    this.pendingHotBytes += retainedHotBytes;
    this.pendingDecodedHotBytes += decodedHotBytes;
    this.totalRows += 1;
  }

  private reserveBuilderHot(bytes: number): boolean {
    const extraNeeded = Math.max(0, bytes - this.hotCreditBytes);
    this.makePerRunHotRoom(extraNeeded);
    const available = this.limits.perRunHotBytes - this.hotBytes - this.hotCreditBytes;
    if (extraNeeded > available) return false;

    if (extraNeeded > 0) {
      const reservation = Math.min(
        Math.max(HOT_RESERVATION_CREDIT_BYTES, extraNeeded),
        available,
      );
      this.hotReservationCalls += 1;
      if (!this.runtime.reserveHot(reservation)) return false;
      this.hotCreditBytes += reservation;
    }
    this.hotCreditBytes -= bytes;
    return true;
  }

  private releaseUnusedHotCredit(): void {
    if (this.hotCreditBytes === 0) return;
    this.runtime.releaseHot(this.hotCreditBytes);
    this.hotCreditBytes = 0;
  }

  private async flushAndAppend(
    row: ResultRow,
    record: EncodedRecord,
    retainHot: boolean,
  ): Promise<void> {
    await this.flushPending(retainHot);
    const pendingAppend = this.appendEncoded(row, record);
    if (pendingAppend) await pendingAppend;
  }

  private async writeDirectAndCount(
    row: ResultRow,
    record: EncodedRecord,
  ): Promise<void> {
    this.releaseUnusedHotCredit();
    await this.writeDirectSegment(row, record);
    this.totalRows += 1;
  }

  private reserveSpill(bytes: number): void {
    if (bytes > this.limits.perRunSpillBytes - this.spillBytes) {
      throw new OutputCapacityError(
        `run spill limit of ${this.limits.perRunSpillBytes} bytes was reached after ${this.totalRows} rows`,
      );
    }
    if (!this.runtime.reserveSpill(bytes)) {
      throw new OutputCapacityError(
        `runtime spill limit of ${this.runtime.globalSpillLimit} bytes was reached after ${this.totalRows} rows`,
      );
    }
    this.spillBytes += bytes;
  }

  private releaseSpillReservation(bytes: number): void {
    this.spillBytes = Math.max(0, this.spillBytes - bytes);
    this.runtime.releaseSpill(bytes);
  }

  private async flushPending(retainHot: boolean): Promise<void> {
    if (this.pendingRows.length === 0) return;
    const rows = this.pendingRows;
    const records = this.pendingRecords;
    const pendingHotBytes = this.pendingHotBytes;
    const decodedHotBytes = this.pendingDecodedHotBytes;
    const start = this.totalRows - rows.length;
    const contents = encodeSegment(records);
    if (contents.byteLength > this.limits.segmentBytes) {
      throw new Error('Result segment exceeded its byte bound');
    }
    const segment = await this.writeSegment(
      start,
      rows.length,
      decodedHotBytes,
      contents,
    );

    this.pendingRows = [];
    this.pendingRecords = [];
    this.pendingBytes = 0;
    this.pendingHotBytes = 0;
    this.pendingDecodedHotBytes = 0;
    this.segments.push(segment);

    if (retainHot && decodedHotBytes <= this.limits.perRunHotBytes) {
      const releasedBuilderBytes = pendingHotBytes - decodedHotBytes;
      this.hotBytes -= releasedBuilderBytes;
      this.runtime.releaseHot(releasedBuilderBytes);
      segment.cachedRows = rows;
      this.registerCache(segment);
    } else {
      this.hotBytes -= pendingHotBytes;
      this.runtime.releaseHot(pendingHotBytes);
    }
  }

  private async writeDirectSegment(
    row: ResultRow,
    record: EncodedRecord,
  ): Promise<void> {
    const contents = encodeSegment([record]);
    const segment = await this.writeSegment(
      this.totalRows,
      1,
      record.decodedHotBytes,
      contents,
    );
    this.segments.push(segment);
    // The row exists only as this method's transient argument; it is not retained.
    void row;
  }

  private async writeSegment(
    start: number,
    count: number,
    hotBytes: number,
    contents: Buffer,
  ): Promise<Segment> {
    const bytes = contents.byteLength;
    this.reserveSpill(bytes);
    for (;;) {
      let path: string;
      try {
        path = join(
          this.runDirectory,
          `segment-${this.fileSystem.randomBytes(16).toString('hex')}.bin`,
        );
      } catch (error) {
        // No write was attempted for this reservation, so there can be no
        // partial file to remove before rolling the reservation back.
        this.releaseSpillReservation(bytes);
        throw error;
      }
      try {
        await this.fileSystem.writeFile(path, contents, { flag: 'wx', mode: 0o600 });
        this.segmentWrites += 1;
        return {
          start,
          count,
          bytes,
          hotBytes,
          path,
          cacheKey: path,
        };
      } catch (error) {
        if (isNodeError(error, 'EEXIST')) continue;
        try {
          await this.fileSystem.remove(path, { force: true });
        } catch (cleanupError) {
          // The path may contain a partial write. Keep the full reservation
          // charged so repeated failures cannot bypass the runtime spill cap.
          throw new AggregateError(
            [error, cleanupError],
            `Failed to write and remove partial output segment: ${path}`,
          );
        }
        this.releaseSpillReservation(bytes);
        throw error;
      }
    }
  }

  /**
   * Return the [start, start+count) window, pulling rows on demand. Read-ahead
   * affects retention progress only and never expands the returned IPC slice.
   */
  getWindow(
    start: number,
    count: number,
    readAhead = 0,
  ): Promise<ResultWindow> {
    const operation = this.readWindow(start, count, readAhead);
    return this.trackWindowRead(operation);
  }

  /**
   * Visit the requested range as contiguous, ordered chunks whose encoded row
   * JSON payload never exceeds one spill segment. This is the production IPC
   * path: a valid 10,000-row request therefore cannot become one unbounded
   * payload. Structured-clone bookkeeping adds engine-owned overhead beyond
   * this UTF-8 bound; a single row is still rejected at segmentBytes.
   */
  forEachWindowChunk(
    start: number,
    count: number,
    readAhead: number,
    visit: (window: ResultWindow) => void,
  ): Promise<void> {
    const operation = this.readWindowChunks(start, count, readAhead, visit);
    return this.trackWindowRead(operation);
  }

  private trackWindowRead<T>(operation: Promise<T>): Promise<T> {
    this.activeWindowReads.add(operation);
    void operation.then(
      () => this.activeWindowReads.delete(operation),
      () => this.activeWindowReads.delete(operation),
    );
    return operation;
  }

  private async readWindow(
    start: number,
    count: number,
    readAhead: number,
  ): Promise<ResultWindow> {
    let windowStart = 0;
    const rows: ResultRow[] = [];
    await this.readWindowChunks(start, count, readAhead, (window) => {
      if (rows.length === 0) windowStart = window.start;
      rows.push(...window.rows);
    });
    return { start: windowStart, rows };
  }

  private async readWindowChunks(
    start: number,
    count: number,
    readAhead: number,
    visit: (window: ResultWindow) => void,
  ): Promise<void> {
    const safeStart = nonNegativeSafeInteger(start, 'window start');
    const safeCount = Math.min(MAX_WINDOW, nonNegativeSafeInteger(count, 'window count'));
    if (this.disposed) {
      visit({ start: safeStart, rows: [] });
      return;
    }
    if (safeStart > this.totalRows + MAX_WINDOW) {
      throw new RangeError(
        `window start ${safeStart} is beyond the retained frontier ${this.totalRows}`,
      );
    }
    const safeReadAhead = Math.min(
      MAX_WINDOW,
      nonNegativeSafeInteger(readAhead, 'window readAhead'),
    );
    const target = checkedSafeSum(safeStart, safeCount, safeReadAhead);
    // A capacity failure is already surfaced as the block's terminal error.
    // Historical rows accepted before that boundary remain pageable, including
    // a final partial window, just like a naturally exhausted source.
    if (!this.failure) await this.ensure(target);

    const end = Math.min(this.totalRows, safeStart + safeCount);
    if (safeStart >= end) {
      visit({ start: safeStart, rows: [] });
      return;
    }

    let cursor = safeStart;
    let chunkStart = safeStart;
    let chunkRows: ResultRow[] = [];
    let chunkBytes = 0;
    const flushChunk = (): void => {
      if (chunkRows.length === 0) return;
      visit({ start: chunkStart, rows: chunkRows });
      chunkRows = [];
      chunkBytes = 0;
    };
    const appendRow = (row: ResultRow): void => {
      const rowBytes = encodedRowByteLength(row);
      if (chunkRows.length > 0 && chunkBytes + rowBytes > this.limits.segmentBytes) {
        flushChunk();
        chunkStart = cursor;
      }
      chunkRows.push(row);
      chunkBytes += rowBytes;
    };

    while (cursor < end) {
      if (this.disposed) return;
      const segment = this.findSegment(cursor);
      if (!segment) {
        // Only possible while an in-flight ensure still owns its pending builder.
        const pendingStart = this.totalRows - this.pendingRows.length;
        if (cursor < pendingStart) throw new Error(`Missing retained output segment for row ${cursor}`);
        const take = Math.min(end - cursor, this.pendingRows.length - (cursor - pendingStart));
        const pendingOffset = cursor - pendingStart;
        for (let index = 0; index < take; index += 1) {
          appendRow(this.pendingRows[pendingOffset + index]);
          cursor += 1;
        }
        continue;
      }
      const segmentRows = await this.loadSegment(segment);
      const offset = cursor - segment.start;
      const take = Math.min(end - cursor, segment.count - offset);
      for (let index = 0; index < take; index += 1) {
        appendRow(segmentRows[offset + index]);
        cursor += 1;
      }
    }
    flushChunk();
  }

  private async loadSegment(segment: Segment): Promise<readonly ResultRow[]> {
    if (segment.cachedRows) {
      this.touchCache(segment);
      return segment.cachedRows;
    }
    if (segment.loading) return segment.loading;

    const loading = this.loadColdSegment(segment);
    segment.loading = loading;
    try {
      return await loading;
    } finally {
      if (segment.loading === loading) segment.loading = undefined;
    }
  }

  private async loadColdSegment(segment: Segment): Promise<readonly ResultRow[]> {
    this.releaseUnusedHotCredit();
    this.makePerRunHotRoom(segment.hotBytes);
    const hasRunRoom = this.hotBytes + segment.hotBytes <= this.limits.perRunHotBytes;
    const reserved = hasRunRoom && this.runtime.reserveHot(segment.hotBytes);
    if (reserved) this.hotBytes += segment.hotBytes;
    try {
      const rows = decodeSegment(await readFile(segment.path), segment);
      if (segment.cachedRows) {
        if (reserved) {
          this.hotBytes = Math.max(0, this.hotBytes - segment.hotBytes);
          this.runtime.releaseHot(segment.hotBytes);
        }
        this.touchCache(segment);
        return segment.cachedRows;
      }
      if (reserved && !this.disposed) {
        segment.cachedRows = rows;
        this.registerCache(segment);
      } else if (reserved) {
        this.hotBytes = Math.max(0, this.hotBytes - segment.hotBytes);
        this.runtime.releaseHot(segment.hotBytes);
      }
      return rows;
    } catch (error) {
      if (reserved) {
        this.hotBytes -= segment.hotBytes;
        this.runtime.releaseHot(segment.hotBytes);
      }
      throw error;
    }
  }

  private tryCacheSegment(segment: Segment, rows: readonly ResultRow[]): void {
    this.releaseUnusedHotCredit();
    this.makePerRunHotRoom(segment.hotBytes);
    if (
      this.hotBytes + segment.hotBytes > this.limits.perRunHotBytes
      || !this.runtime.reserveHot(segment.hotBytes)
    ) {
      return;
    }
    this.hotBytes += segment.hotBytes;
    segment.cachedRows = rows;
    this.registerCache(segment);
  }

  private registerCache(segment: Segment): void {
    this.cacheLru.set(segment.cacheKey, segment);
    this.runtime.registerCache(segment.cacheKey, segment.hotBytes, () => {
      if (!segment.cachedRows) return;
      segment.cachedRows = undefined;
      this.cacheLru.delete(segment.cacheKey);
      this.hotBytes = Math.max(0, this.hotBytes - segment.hotBytes);
    });
  }

  private touchCache(segment: Segment): void {
    this.cacheLru.delete(segment.cacheKey);
    this.cacheLru.set(segment.cacheKey, segment);
    this.runtime.touchCache(segment.cacheKey);
  }

  private makePerRunHotRoom(bytes: number): void {
    while (this.hotBytes + this.hotCreditBytes + bytes > this.limits.perRunHotBytes) {
      const oldest = this.cacheLru.keys().next();
      if (oldest.done) break;
      this.runtime.evictCache(oldest.value);
    }
  }

  private findSegment(index: number): Segment | undefined {
    let low = 0;
    let high = this.segments.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const segment = this.segments[middle];
      if (index < segment.start) high = middle - 1;
      else if (index >= segment.start + segment.count) low = middle + 1;
      else return segment;
    }
    return undefined;
  }

  /**
   * Stop only the producer. Retained rows and spill files stay available for
   * post-command scrolling until the owning block calls `dispose()`.
   */
  async stopSource(): Promise<void> {
    this.done = true;
    try {
      await this.queueIteratorStop();
    } finally {
      this.releaseUnusedHotCredit();
    }
  }

  private queueIteratorStop(): Promise<void> {
    const stop = this.advanceChain.then(() => this.stopIterator());
    this.advanceChain = stop.then(
      () => undefined,
      () => undefined,
    );
    return stop;
  }

  private async stopIterator(): Promise<void> {
    if (this.sourceStopped) return;
    this.sourceStopped = true;
    await this.iterator.return?.();
  }

  /** Stop the producer and deterministically release every file and quota. */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    const operation = this.disposeInternal();
    this.disposePromise = operation;
    // Concurrent callers share one attempt, but a failed physical deletion
    // must not poison future retries with the same cached rejected promise.
    void operation.catch(() => {
      if (this.disposePromise === operation) this.disposePromise = null;
    });
    return operation;
  }

  private async disposeInternal(): Promise<void> {
    this.disposed = true;
    this.done = true;
    await this.queueIteratorStop().catch(() => undefined);
    this.releaseUnusedHotCredit();
    await Promise.allSettled([...this.activeWindowReads]);

    for (const key of [...this.cacheLru.keys()]) this.runtime.evictCache(key);
    if (this.pendingHotBytes > 0) {
      this.hotBytes = Math.max(0, this.hotBytes - this.pendingHotBytes);
      this.runtime.releaseHot(this.pendingHotBytes);
    }
    this.pendingRows = [];
    this.pendingRecords = [];
    this.pendingBytes = 0;
    this.pendingHotBytes = 0;
    this.pendingDecodedHotBytes = 0;

    await this.fileSystem.remove(this.runDirectory, { recursive: true, force: true });
    // Release disk accounting only after the directory is actually gone. On a
    // Windows sharing/ACL failure dispose rejects and leaves the reservation
    // charged, failing closed instead of permitting unbounded orphan spill.
    this.runtime.releaseSpill(this.spillBytes);
    this.spillBytes = 0;
    this.segments.length = 0;
  }

  diagnostics(): ResultStoreDiagnostics {
    return {
      hotBytes: this.hotBytes + this.hotCreditBytes,
      spillBytes: this.spillBytes,
      segments: this.segments.length,
      hotReservationCalls: this.hotReservationCalls,
      segmentWrites: this.segmentWrites,
      runDirectory: this.runDirectory,
    };
  }
}

function encodeRow(row: ResultRow): EncodedRecord {
  const json = JSON.stringify(row);
  if (json === undefined) throw new TypeError('Result row is not JSON serializable');
  const byteLength = RECORD_HEADER_BYTES + Buffer.byteLength(json, 'utf8');
  const decodedHotBytes = estimateDecodedJsonTextHeap(json);
  return {
    json,
    byteLength,
    decodedHotBytes,
    // JSON string + EncodedRecord wrapper + two builder-array slots.
    retainedHotBytes: decodedHotBytes + 24 + json.length * 2 + 96,
  };
}

function encodeSegment(records: readonly EncodedRecord[]): Buffer {
  const json = `[${records.map((record) => record.json).join(',')}]`;
  return Buffer.from(json, 'utf8');
}

function encodedRowByteLength(row: ResultRow): number {
  const json = JSON.stringify(row);
  if (json === undefined) throw new TypeError('Result row is not JSON serializable');
  return RECORD_HEADER_BYTES + Buffer.byteLength(json, 'utf8');
}

function estimateDecodedJsonTextHeap(json: string): number {
  // The text itself covers string/key code units. Structural tokens add
  // conservative decoded object slots without walking the row object again.
  // Counting punctuation inside string literals only over-reserves quota.
  let bytes = 32 + json.length * 2;
  for (let index = 0; index < json.length; index += 1) {
    const character = json.charCodeAt(index);
    if (character === 0x7b) bytes += 48; // object
    else if (character === 0x5b) bytes += 64; // array + first slot
    else if (character === 0x3a) bytes += 48; // property/key/value slot
    else if (character === 0x2c) bytes += 32; // next property/array slot
  }
  return bytes;
}

function decodeSegment(contents: Buffer, segment: Pick<Segment, 'count' | 'bytes' | 'path'>): ResultRow[] {
  if (contents.byteLength !== segment.bytes) {
    throw new Error(`Corrupt output segment length: ${segment.path}`);
  }
  const decoded = JSON.parse(contents.toString('utf8')) as unknown;
  if (!Array.isArray(decoded) || decoded.length !== segment.count) {
    throw new Error(`Corrupt output segment row count: ${segment.path}`);
  }
  return decoded as ResultRow[];
}

function validateLimits(limits: OutputRetentionLimits): OutputRetentionLimits {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
  if (limits.perRunHotBytes > limits.globalHotBytes) {
    throw new RangeError('perRunHotBytes cannot exceed globalHotBytes');
  }
  if (limits.perRunSpillBytes > limits.globalSpillBytes) {
    throw new RangeError('perRunSpillBytes cannot exceed globalSpillBytes');
  }
  return Object.freeze({ ...limits });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  const integer = Math.trunc(value);
  if (!Number.isSafeInteger(integer) || integer < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return integer;
}

function checkedSafeSum(...values: readonly number[]): number {
  let sum = 0;
  for (const value of values) {
    if (value > Number.MAX_SAFE_INTEGER - sum) {
      throw new RangeError('result window coordinates exceed the safe integer range');
    }
    sum += value;
  }
  return sum;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
