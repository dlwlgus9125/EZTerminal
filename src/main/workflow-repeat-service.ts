import { createHash } from 'node:crypto';
import { z } from 'zod';

import { PLANNING_REPEAT_PRINCIPAL } from '../shared/planning-execution';
import {
  WorkflowIdSchema, type WorkflowCommand, type WorkflowPrincipal, type WorkflowRegistry, type WorkflowRepeat, type WorkflowRepeatStatus, type WorkflowResult,
} from '../shared/workflow';
import { SecureAtomicFile, type SecureAtomicFileOptions } from './secure-atomic-file';
import { nextRepeatAt, occurrenceKey, repeatConfigDigest } from './workflow-repeat-time';
import type { WorkflowRepeatSource } from './workflow-service';

/** An occurrence runs if the host can start it within this long of its time; later, it is recorded as missed. */
export const REPEAT_GRACE_MS = 30 * 60_000;
/** The schedule looks at the wall clock at least this often (a sleeping PC's timers drift). */
export const REPEAT_RECHECK_MS = 5 * 60_000;
/** Occurrences kept per subproject (an unresolved claim is always kept). */
export const REPEAT_HISTORY_LIMIT = 60;
export const REPEAT_FILE = 'workflow-repeat-v1.json';
const RETRY_MS = 60_000;
/** How far back missed occurrences are counted (a host off for longer counts from here). */
const MISSED_LOOKBACK_MS = 370 * 24 * 60 * 60_000;
export const REPEAT_SCHEDULE_PRINCIPAL: WorkflowPrincipal = { kind: 'schedule', id: PLANNING_REPEAT_PRINCIPAL };

const instant = z.string().datetime();
const OccurrenceSchema = z.object({
  key: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), occurrenceAt: instant,
  state: z.enum(['claimed', 'started', 'skipped-running', 'missed', 'failed']), at: instant,
  commandId: WorkflowIdSchema, runId: WorkflowIdSchema,
  detail: z.string().max(500).optional(), missedCount: z.number().int().positive().optional(),
}).strict();
type Occurrence = z.infer<typeof OccurrenceSchema>;
const EntrySchema = z.object({
  projectId: z.string().min(1).max(200), subprojectId: WorkflowIdSchema,
  /** Occurrences before this (turned on, its time changed, restored, automation turned on) never run. */
  armed: z.object({ configDigest: z.string().regex(/^[0-9a-f]{32}$/u), armedAt: instant }).strict().optional(),
  occurrences: z.array(OccurrenceSchema),
}).strict();
type Entry = z.infer<typeof EntrySchema>;
const FileSchema = z.object({ version: z.literal(1), entries: z.array(EntrySchema) }).strict();

/** The fixed ids one occurrence runs under: the same day of the same flow is always the same request. */
export function repeatOccurrenceIds(projectId: string, subprojectId: string, key: string): { commandId: string; runId: string } {
  const hash = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40);
  return { commandId: `schedule-${hash(projectId, subprojectId, key)}`, runId: `repeat-${hash(projectId, subprojectId, key, 'run')}` };
}

export interface WorkflowRepeatServiceOptions {
  readonly directory: string;
  readonly file?: SecureAtomicFileOptions;
  readonly hostId: string;
  /** The projects whose flows may repeat (not archived). */
  readonly projectIds: () => readonly string[];
  readonly sources: (projectId: string) => Promise<readonly WorkflowRepeatSource[]>;
  /** Whether the flow service recorded this command (it does so before any effect). */
  readonly hasReceipt: (projectId: string, commandId: string) => Promise<boolean>;
  readonly launch: (command: WorkflowCommand, principal: WorkflowPrincipal) => Promise<WorkflowResult>;
  /** keepRunning && startAtLogin: repeats run only while the host keeps running from login. */
  readonly automationEnabled: () => boolean;
  /** A subproject's repeat record changed (screens read the flow again). */
  readonly onChanged?: (projectId: string) => void;
  readonly reportError?: (error: unknown) => void;
  readonly now?: () => Date;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/**
 * 반복: runs a flow's saved 다시 실행 at its local time. Each occurrence is claimed on disk before it is
 * launched under ids derived from its day, so a crash, a lost reply or a second host tick replays the same
 * request instead of starting another run. A late occurrence runs only within REPEAT_GRACE_MS of its time.
 */
export class WorkflowRepeatService {
  private readonly file: SecureAtomicFile;
  private entries = new Map<string, Entry>();
  private state: 'unloaded' | 'ready' | 'unreadable' = 'unloaded';
  private initialized = false;
  private started = false;
  private disposed = false;
  private running: Promise<void> | undefined;
  private again = false;
  private timer: unknown;

  constructor(private readonly options: WorkflowRepeatServiceOptions) {
    this.file = new SecureAtomicFile(options.directory, REPEAT_FILE, { maxBytes: 8 * 1024 * 1024, ...options.file });
  }

  start(): Promise<void> {
    if (this.started || this.disposed) return Promise.resolve();
    this.started = true;
    return this.wake();
  }

  /** Look again now: the PC resumed, automation or a flow changed. Settles when that look is done. */
  wake(): Promise<void> {
    if (!this.started || this.disposed) return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    this.cancelTimer();
    this.running = (async () => {
      let wait = REPEAT_RECHECK_MS;
      do {
        this.again = false;
        wait = await this.tick().catch((error: unknown) => { this.options.reportError?.(error); return REPEAT_RECHECK_MS; });
      } while (this.again && !this.disposed);
      if (!this.disposed) this.schedule(wait);
    })().finally(() => { this.running = undefined; });
    return this.running;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelTimer();
    await this.running;
    await this.file.enqueue(async () => undefined);
  }

  /** What each repeating subproject of `registry` did and will do (answered with every flow read). */
  status(registry: WorkflowRegistry): Record<string, WorkflowRepeatStatus> {
    const now = this.now();
    const auto = this.options.automationEnabled();
    const result: Record<string, WorkflowRepeatStatus> = {};
    for (const subproject of registry.subprojects) {
      const repeat = subproject.repeat;
      if (!repeat) continue;
      const entry = this.entries.get(entryKey(registry.projectId, subproject.id));
      const last = latest(entry);
      const blocked = !repeat.enabled ? undefined
        : this.state === 'unreadable' ? 'unreadable' as const
          : !auto ? 'automation-off' as const
            : !subproject.runSettings?.reviewer ? 'missing-reviewer' as const : undefined;
      const nextAt = repeat.enabled && !blocked && subproject.status === 'active' ? this.nextAt(repeat, entry, now) : undefined;
      result[subproject.id] = {
        ...(nextAt ? { nextAt } : {}), ...(blocked ? { blocked } : {}),
        ...(last ? { last: { key: last.key, occurrenceAt: last.occurrenceAt, state: last.state, at: last.at, runId: last.runId,
          ...(last.detail ? { detail: last.detail } : {}), ...(last.missedCount ? { missedCount: last.missedCount } : {}) } } : {}),
      };
    }
    return result;
  }

  private now(): Date { return this.options.now?.() ?? new Date(); }

  private schedule(ms: number): void {
    // Never longer than the wall-clock recheck, never a spin when a timer fires a little early.
    const delay = Math.min(REPEAT_RECHECK_MS, Math.max(1_000, Math.ceil(ms)));
    const set = this.options.setTimer ?? ((run, wait) => { const handle = setTimeout(run, wait); handle.unref?.(); return handle; });
    this.timer = set(() => { this.timer = undefined; void this.wake(); }, delay);
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    (this.options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)))(this.timer);
    this.timer = undefined;
  }

  /** Reads the record. One that cannot be read is left exactly as it is, and nothing repeats until it can. */
  private async load(): Promise<boolean> {
    try {
      if (!this.initialized) { await this.file.init(); this.initialized = true; }
      const text = await this.file.readText();
      const parsed = text === undefined ? { version: 1 as const, entries: [] } : FileSchema.parse(JSON.parse(text));
      this.entries = new Map(parsed.entries.map(entry => [entryKey(entry.projectId, entry.subprojectId), entry]));
      if (this.state === 'unreadable') this.notifyAll();
      this.state = 'ready';
      return true;
    } catch (error) {
      if (this.state !== 'unreadable') { this.state = 'unreadable'; this.options.reportError?.(error); this.notifyAll(); }
      return false;
    }
  }

  private notifyAll(): void {
    for (const projectId of new Set([...this.entries.values()].map(entry => entry.projectId).concat(this.options.projectIds()))) this.options.onChanged?.(projectId);
  }

  /** Returns how long until it needs to look again. */
  private async tick(): Promise<number> {
    if (this.state !== 'ready' && !await this.load()) return REPEAT_RECHECK_MS;
    let wait = REPEAT_RECHECK_MS;
    for (const projectId of this.options.projectIds()) {
      if (this.disposed) break;
      let sources: readonly WorkflowRepeatSource[];
      try { sources = await this.options.sources(projectId); } catch (error) { this.options.reportError?.(error); continue; }
      for (const source of sources) {
        if (this.disposed) break;
        try { wait = Math.min(wait, await this.check(projectId, source)); } catch (error) { this.options.reportError?.(error); }
      }
    }
    return wait;
  }

  private async check(projectId: string, source: WorkflowRepeatSource): Promise<number> {
    const id = entryKey(projectId, source.subprojectId);
    const auto = this.options.automationEnabled();
    const eligible = auto && source.repeat.enabled && source.status === 'active';
    const digest = repeatConfigDigest(source.repeat);
    let entry = this.entries.get(id) ?? { projectId, subprojectId: source.subprojectId, occurrences: [] };
    // Off, completed, archived or automation off: whatever comes before turning it back on never runs.
    if (!eligible && entry.armed) entry = await this.save({ ...entry, armed: undefined });
    if (eligible && entry.armed?.configDigest !== digest) entry = await this.save({ ...entry, armed: { configDigest: digest, armedAt: this.now().toISOString() } });
    if (!auto) return REPEAT_RECHECK_MS;
    let wait = REPEAT_RECHECK_MS;
    for (const claim of entry.occurrences.filter(occurrence => occurrence.state === 'claimed')) {
      if (this.disposed) return wait;
      if (await this.resolveClaim(projectId, source, claim, eligible) === 'retry') wait = RETRY_MS;
    }
    if (!eligible || !source.reviewer || this.disposed) return wait;
    entry = this.entries.get(id)!;
    const now = this.now();
    const lastAt = entry.occurrences.reduce((value, occurrence) => Math.max(value, Date.parse(occurrence.occurrenceAt)), 0);
    let cursor = new Date(Math.max(Date.parse(entry.armed!.armedAt), lastAt, now.getTime() - MISSED_LOOKBACK_MS));
    let missed: { at: Date; key: string; count: number } | undefined;
    let due: { at: Date; key: string } | undefined;
    for (;;) {
      const at = nextRepeatAt(source.repeat, cursor);
      if (at.getTime() > now.getTime()) { wait = Math.min(wait, at.getTime() - now.getTime()); break; }
      cursor = at;
      const key = occurrenceKey(source.repeat, at);
      // One run per local day: a day already tried is not tried again (a missed one may run after a change).
      if (entry.occurrences.some(occurrence => occurrence.key === key && occurrence.state !== 'missed')) continue;
      if (now.getTime() - at.getTime() > REPEAT_GRACE_MS) { missed = { at, key, count: (missed?.count ?? 0) + 1 }; continue; }
      due = { at, key }; break;
    }
    if (missed) {
      await this.record(projectId, source.subprojectId, { key: missed.key, occurrenceAt: missed.at.toISOString(), state: 'missed', at: now.toISOString(),
        ...repeatOccurrenceIds(projectId, source.subprojectId, missed.key), missedCount: missed.count, detail: 'The host was not running within 30 minutes of this time.' });
    }
    if (due && !this.disposed) {
      // Claimed on disk first: whatever happens next, this day's request is the one replayed.
      const claim = await this.record(projectId, source.subprojectId, { key: due.key, occurrenceAt: due.at.toISOString(), state: 'claimed', at: now.toISOString(),
        ...repeatOccurrenceIds(projectId, source.subprojectId, due.key) });
      if (await this.run(projectId, source, claim) === 'retry') wait = Math.min(wait, RETRY_MS);
    }
    return wait;
  }

  /**
   * A claim left open (a crash, a lost reply). Recorded by the flow service: replay it, whatever the time.
   * Not recorded: nothing started, so it runs only as a first try would (still on, within the window).
   */
  private async resolveClaim(projectId: string, source: WorkflowRepeatSource, claim: Occurrence, eligible: boolean): Promise<'settled' | 'retry'> {
    let recorded: boolean;
    try { recorded = await this.options.hasReceipt(projectId, claim.commandId); } catch (error) { this.options.reportError?.(error); return 'retry'; }
    if (recorded) return this.run(projectId, source, claim);
    const entry = this.entries.get(entryKey(projectId, source.subprojectId));
    const armedAt = entry?.armed ? Date.parse(entry.armed.armedAt) : Number.POSITIVE_INFINITY;
    const occurrenceAt = Date.parse(claim.occurrenceAt);
    if (eligible && source.reviewer && occurrenceAt >= armedAt && this.now().getTime() - occurrenceAt <= REPEAT_GRACE_MS) return this.run(projectId, source, claim);
    await this.record(projectId, source.subprojectId, { ...claim, state: 'missed', at: this.now().toISOString(),
      detail: eligible ? 'The run could not start within 30 minutes of this time.' : 'The repeat was turned off before the run started.' });
    return 'settled';
  }

  private async run(projectId: string, source: WorkflowRepeatSource, claim: Occurrence): Promise<'settled' | 'retry'> {
    let result: WorkflowResult;
    try {
      result = await this.options.launch({ type: 'run.launch', hostId: this.options.hostId, projectId, subprojectId: source.subprojectId,
        commandId: claim.commandId, expectedRevision: source.revision, payload: { runId: claim.runId } }, REPEAT_SCHEDULE_PRINCIPAL);
    } catch (error) {
      result = { ok: false, error: 'execution-unavailable', message: error instanceof Error ? error.message : String(error) };
    }
    // Unknown outcome or a flow edited since it was read: the claim stays and is looked at again.
    if (!result.ok && ['execution-unavailable', 'revision-conflict', 'unavailable'].includes(result.error)) return 'retry';
    const at = this.now().toISOString();
    await this.record(projectId, source.subprojectId, result.ok ? { ...claim, state: 'started', at, detail: undefined }
      : { ...claim, state: result.error === 'active-run' ? 'skipped-running' : 'failed', at, detail: result.message.slice(0, 500) });
    return 'settled';
  }

  private async record(projectId: string, subprojectId: string, occurrence: Occurrence): Promise<Occurrence> {
    const entry = this.entries.get(entryKey(projectId, subprojectId)) ?? { projectId, subprojectId, occurrences: [] };
    await this.save({ ...entry, occurrences: [...entry.occurrences.filter(item => item.key !== occurrence.key), stripUndefined(occurrence)] });
    return occurrence;
  }

  /** Saved before it is used: the record on disk is never behind what the schedule acted on. */
  private async save(entry: Entry): Promise<Entry> {
    const open = entry.occurrences.filter(occurrence => occurrence.state === 'claimed');
    const settled = entry.occurrences.filter(occurrence => occurrence.state !== 'claimed').sort(byTime).slice(-REPEAT_HISTORY_LIMIT);
    const saved: Entry = stripUndefined({ ...entry, occurrences: [...settled, ...open].sort(byTime) });
    const next = new Map(this.entries).set(entryKey(entry.projectId, entry.subprojectId), saved);
    const data = `${JSON.stringify({ version: 1, entries: [...next.values()] }, null, 2)}\n`;
    await this.file.enqueue(() => this.file.writeAtomic(data));
    this.entries = next;
    this.options.onChanged?.(entry.projectId);
    return saved;
  }

  /** The next occurrence it would run (a day already tried is skipped), from now or when it was armed. */
  private nextAt(repeat: WorkflowRepeat, entry: Entry | undefined, now: Date): string | undefined {
    const armedAt = entry?.armed?.configDigest === repeatConfigDigest(repeat) ? Date.parse(entry.armed.armedAt) : 0;
    const lastAt = (entry?.occurrences ?? []).reduce((value, occurrence) => Math.max(value, Date.parse(occurrence.occurrenceAt)), 0);
    let cursor = new Date(Math.max(now.getTime(), armedAt, lastAt));
    try {
      for (let index = 0; index < 8; index += 1) {
        const at = nextRepeatAt(repeat, cursor);
        const key = occurrenceKey(repeat, at);
        if (!entry?.occurrences.some(occurrence => occurrence.key === key && occurrence.state !== 'missed')) return at.toISOString();
        cursor = at;
      }
    } catch { return undefined; }
    return undefined;
  }
}

function entryKey(projectId: string, subprojectId: string): string { return `${projectId}\n${subprojectId}`; }
function byTime(left: Occurrence, right: Occurrence): number { return Date.parse(left.occurrenceAt) - Date.parse(right.occurrenceAt) || Date.parse(left.at) - Date.parse(right.at); }
function latest(entry: Entry | undefined): Occurrence | undefined { return entry?.occurrences.slice().sort(byTime).at(-1); }
function stripUndefined<T extends object>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
