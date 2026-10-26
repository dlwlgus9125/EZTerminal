/**
 * When this renderer saw each terminal run start and end, by run id, so a
 * block reopened after its view was closed (tab moved, pane remounted) keeps
 * its time and duration. Runs started elsewhere and only caught up later have
 * no entry; their blocks show no time rather than a wrong one.
 */

export interface BlockTiming {
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
}

const MAX_RUNS = 1_000;
const timings = new Map<string, { startedAtMs: number; endedAtMs?: number }>();

export function rememberBlockStart(runId: string, startedAtMs: number): void {
  if (timings.has(runId)) return;
  timings.set(runId, { startedAtMs });
  while (timings.size > MAX_RUNS) {
    const oldest = timings.keys().next().value;
    if (oldest === undefined) break;
    timings.delete(oldest);
  }
}

export function rememberBlockEnd(runId: string, endedAtMs: number | null): void {
  const timing = timings.get(runId);
  if (timing && endedAtMs !== null && timing.endedAtMs === undefined) timing.endedAtMs = endedAtMs;
}

/** Controller options for a run seen before, or nothing. */
export function rememberedBlockTiming(runId: string): BlockTiming {
  const timing = timings.get(runId);
  return timing ? { startedAtMs: timing.startedAtMs, ...(timing.endedAtMs !== undefined ? { endedAtMs: timing.endedAtMs } : {}) } : {};
}
