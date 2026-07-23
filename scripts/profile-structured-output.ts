import { performance } from 'node:perf_hooks';

import { runBlock } from '../src/interpreter/block-runner';
import {
  evaluate,
  parse,
  recordToJson,
  toRowIterable,
} from '../src/interpreter/core';
import { ResultStore } from '../src/interpreter/result-store';
import { ShellSession } from '../src/interpreter/shell-session';
import type { InterpreterFrame, ResultRow } from '../src/shared/ipc';

const rowCount = Number.parseInt(process.argv[2] ?? '100000', 10);
const iterations = Number.parseInt(process.argv[3] ?? '3', 10);
const requestedStage = process.argv[4] ?? 'all';
if (!Number.isSafeInteger(rowCount) || rowCount <= 0) {
  throw new Error('row count must be a positive safe integer');
}
if (!Number.isSafeInteger(iterations) || iterations <= 0) {
  throw new Error('iteration count must be a positive safe integer');
}

function dataFor(count: number, signal: AbortSignal) {
  return evaluate(
    parse(`gen-rows ${count}`),
    new ShellSession(process.cwd()).createContext(signal),
  );
}

async function measureSourceConversion(): Promise<{ readonly rows: number }> {
  const signal = new AbortController().signal;
  const data = dataFor(rowCount, signal);
  let rows = 0;
  for await (const record of toRowIterable(data)) {
    recordToJson(record);
    rows += 1;
  }
  return { rows };
}

async function measureRetention(): Promise<{
  readonly rows: number;
  readonly segments: number;
  readonly spillBytes: number;
  readonly hotReservationCalls: number;
  readonly segmentWrites: number;
}> {
  let index = 0;
  const iterator: AsyncIterator<ResultRow> = {
    next(): Promise<IteratorResult<ResultRow>> {
      if (index >= rowCount) return Promise.resolve({ done: true, value: undefined });
      index += 1;
      return Promise.resolve({
        done: false,
        value: { n: index, name: `row-${index}` },
      });
    },
  };
  const store = new ResultStore(iterator);
  try {
    await store.ensure(rowCount + 1);
    const diagnostics = store.diagnostics();
    return {
      rows: store.count,
      segments: diagnostics.segments,
      spillBytes: diagnostics.spillBytes,
      hotReservationCalls: diagnostics.hotReservationCalls,
      segmentWrites: diagnostics.segmentWrites,
    };
  } finally {
    await store.dispose();
  }
}

async function measureBlockRunner(): Promise<{
  readonly progressFrames: number;
  readonly chunkRows: number;
}> {
  const signal = new AbortController().signal;
  const data = dataFor(rowCount, signal);
  let progressFrames = 0;
  let chunkRows = 0;
  const emit = (frame: InterpreterFrame): void => {
    if (frame.type === 'progress') progressFrames += 1;
    if (frame.type === 'chunk') chunkRows += frame.rows.length;
  };
  const handle = runBlock(data, emit, signal);
  try {
    await handle.done;
    return { progressFrames, chunkRows };
  } finally {
    await handle.dispose();
  }
}

async function sample<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<void> {
  const samples: number[] = [];
  let lastResult: T | undefined;
  await operation(); // one unreported JIT/filesystem warmup
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    // The profiler is deliberately serialized to avoid cross-stage I/O noise.
    // eslint-disable-next-line no-await-in-loop
    lastResult = await operation();
    samples.push(Math.round((performance.now() - startedAt) * 100) / 100);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const medianMs = sorted[Math.floor(sorted.length / 2)];
  process.stdout.write(`${JSON.stringify({
    label,
    rowCount,
    iterations,
    samplesMs: samples,
    medianMs,
    operations: lastResult,
  })}\n`);
}

if (requestedStage === 'all' || requestedStage === 'source') {
  await sample('source-conversion', measureSourceConversion);
}
if (requestedStage === 'all' || requestedStage === 'store') {
  await sample('result-store-retention', measureRetention);
}
if (requestedStage === 'all' || requestedStage === 'block') {
  await sample('block-runner-completion', measureBlockRunner);
}
