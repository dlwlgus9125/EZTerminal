import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { PLANNING_REPEAT_PRINCIPAL } from '../shared/planning-execution';
import {
  WorkflowIdSchema, type WorkflowCommand, type WorkflowPrincipal, type WorkflowRegistry, type WorkflowRepeat, type WorkflowRepeatStatus, type WorkflowResult,
} from '../shared/workflow';
import { nextRepeatAt, occurrenceKey, repeatConfigDigest } from './workflow-repeat-time';
import { launchIntentDigest, repeatContentDigest, type WorkflowLaunchReceipt, type WorkflowRepeatConsentChange, type WorkflowRepeatSource } from './workflow-service';

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
  /** launchIntentDigest of what this host claimed to run: a recorded launch is replayed only if it still says this. */
  intent: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  detail: z.string().max(500).optional(), missedCount: z.number().int().positive().optional(),
}).strict();
type Occurrence = z.infer<typeof OccurrenceSchema>;
const EntrySchema = z.object({
  projectId: z.string().min(1).max(200), subprojectId: WorkflowIdSchema,
  /**
   * A person turned this repeat on through this host, for exactly this content (repeatContentDigest). The flow
   * file sits in the project folder, so a repeat that arrives with it (a clone, a pull), or a flow changed there,
   * never runs until someone turns it on here; edits made through this host move the consent along.
   */
  consent: z.object({ contentDigest: z.string().regex(/^[0-9a-f]{64}$/u), at: instant }).strict().optional(),
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
  /** The host's user data folder: the record is host settings (ids, times, digests), not a secret. */
  readonly directory: string;
  readonly hostId: string;
  /** The projects whose flows may repeat (not archived). */
  readonly projectIds: () => readonly string[];
  readonly sources: (projectId: string) => Promise<readonly WorkflowRepeatSource[]>;
  /** What the flow service recorded for this command (it does so before any effect). */
  readonly launchReceipt: (projectId: string, commandId: string) => Promise<WorkflowLaunchReceipt>;
  /** WorkflowService.execute: `expected.launchIntent` is checked under its gate right before anything is recorded or run. */
  readonly launch: (command: WorkflowCommand, principal: WorkflowPrincipal, expected?: { readonly launchIntent?: string }) => Promise<WorkflowResult>;
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
  private readonly file: RecordFile;
  private entries = new Map<string, Entry>();
  private state: 'unloaded' | 'ready' | 'unreadable' = 'unloaded';
  /** The record's text as this service last read or wrote it (undefined: no file). Anything else on disk is someone else's. */
  private known: string | undefined;
  private initialized = false;
  private syncing: Promise<boolean> | undefined;
  private started = false;
  private disposed = false;
  private running: Promise<void> | undefined;
  private again = false;
  private timer: unknown;
  /** When automation was last seen turning on: 0 = on since this host started, undefined = off. */
  private automationOnSince: number | undefined;

  constructor(private readonly options: WorkflowRepeatServiceOptions) {
    this.file = new RecordFile(path.join(options.directory, REPEAT_FILE));
  }

  /** After the host's runtime settings are settled (automation read at this moment counts as "on since start"). */
  start(): Promise<void> {
    if (this.started || this.disposed) return Promise.resolve();
    this.started = true;
    this.automationOnSince = this.options.automationEnabled() ? 0 : undefined;
    return this.wake();
  }

  /**
   * Look again now: the PC resumed, automation or a flow changed. Automation is read at every call, so a switch
   * off and back on while a look is still reading flows is seen. Settles when that look is done.
   */
  wake(): Promise<void> {
    if (!this.started || this.disposed) return Promise.resolve();
    this.sampleAutomation();
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

  /**
   * Called by the flow service right after it saved a subproject with 반복, under that project's gate (see
   * WorkflowRepeatConsentChange): a person's 반복 save sets consent for the saved content (or withdraws it); any
   * other edit through this host moves a consent that matched the content before it. Content changed anywhere
   * else is never consented to. It also arms at this moment: an occurrence right after turning 반복 on, changing
   * its time or restoring the flow runs even if no look happens before it.
   */
  async consent(projectId: string, subprojectId: string, change: WorkflowRepeatConsentChange): Promise<void> {
    const at = this.now().toISOString();
    await this.update(projectId, subprojectId, entry => {
      const follows = !change.set && !!entry.consent && entry.consent.contentDigest === change.before;
      if (!change.set && !follows) return entry;
      const consent = change.after ? { contentDigest: change.after, at: change.set ? at : entry.consent!.at } : undefined;
      // An edit of a confirmed flow, or the same flow saved again, keeps its arming; anything newly confirmed (turned
      // on, its time changed, a flow that came from outside confirmed) counts from this save.
      const continuing = follows || entry.consent?.contentDigest === change.after;
      const armed = !consent || !change.runnable || !change.config ? undefined
        : continuing && entry.armed?.configDigest === change.config ? entry.armed : { configDigest: change.config, armedAt: at };
      return { ...entry, consent, armed };
    });
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
          : this.state === 'ready' && entry?.consent?.contentDigest !== repeatContentDigest(subproject) ? 'unconfirmed' as const
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

  /** Reads automation now; an off seen anywhere makes the next on a fresh start (see automationOnSince). */
  private sampleAutomation(): boolean {
    if (!this.options.automationEnabled()) { this.automationOnSince = undefined; return false; }
    this.automationOnSince ??= this.now().getTime();
    return true;
  }

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

  /** Brings the in-memory record in line with the file. False while it cannot be read. */
  private sync(): Promise<boolean> {
    this.syncing ??= this.file.enqueue(() => this.syncNow()).finally(() => { this.syncing = undefined; });
    return this.syncing;
  }

  /**
   * In the file's queue. A record changed by someone else is read again: a valid one is taken as it is, one that
   * cannot be read is left exactly as it is and nothing repeats (or is written) until it can be.
   */
  private async syncNow(): Promise<boolean> {
    try {
      if (!this.initialized) { await this.file.init(); this.initialized = true; }
      const text = await this.file.read();
      if (this.state === 'ready' && text === this.known) return true;
      const parsed = text === undefined ? { version: 1 as const, entries: [] } : FileSchema.parse(JSON.parse(text));
      this.entries = new Map(parsed.entries.map(entry => [entryKey(entry.projectId, entry.subprojectId), entry]));
      this.known = text;
      const recovered = this.state === 'unreadable';
      this.state = 'ready';
      if (recovered) this.notifyAll();
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
    if (!await this.sync()) return REPEAT_RECHECK_MS;
    let wait = REPEAT_RECHECK_MS;
    for (const projectId of this.options.projectIds()) {
      if (this.disposed) break;
      let sources: readonly WorkflowRepeatSource[];
      // A consent or arming saved after this read is newer than what the read says (a person saved meanwhile).
      const readAt = this.now().getTime();
      try { sources = await this.options.sources(projectId); } catch (error) { this.options.reportError?.(error); continue; }
      for (const source of sources) {
        if (this.disposed) break;
        try { wait = Math.min(wait, await this.check(projectId, source, readAt)); } catch (error) { this.options.reportError?.(error); }
      }
    }
    return wait;
  }

  private async check(projectId: string, source: WorkflowRepeatSource, readAt: number): Promise<number> {
    const id = entryKey(projectId, source.subprojectId);
    const auto = this.sampleAutomation();
    const digest = repeatConfigDigest(source.repeat);
    let entry = this.entries.get(id) ?? { projectId, subprojectId: source.subprojectId, occurrences: [] };
    const eligible = auto && source.repeat.enabled && source.status === 'active' && entry.consent?.contentDigest === source.contentDigest;
    const older = (value: { at?: string; armedAt?: string } | undefined) => !!value && Date.parse(value.at ?? value.armedAt!) <= readAt;
    // Off in the saved flow: the consent goes too, so the file alone can never turn it back on.
    if (!source.repeat.enabled && older(entry.consent)) entry = await this.update(projectId, source.subprojectId, current => (older(current.consent) ? { ...current, consent: undefined } : current));
    // Off, not confirmed here, completed, archived or automation off: what comes before turning it back on never runs.
    if (!eligible && older(entry.armed)) entry = await this.update(projectId, source.subprojectId, current => (older(current.armed) ? { ...current, armed: undefined } : current));
    if (eligible) {
      // A flow change through this host armed it already (consent). Left here: automation turned (back) on, from then.
      const floor = this.automationOnSince ?? 0;
      const stale = (armed: Entry['armed']) => !armed || armed.configDigest !== digest || Date.parse(armed.armedAt) < floor;
      if (stale(entry.armed)) {
        const armedAt = new Date(floor > 0 ? floor : this.now().getTime()).toISOString();
        entry = await this.update(projectId, source.subprojectId, current => (stale(current.armed) ? { ...current, armed: { configDigest: digest, armedAt } } : current));
      }
    }
    if (!auto) return REPEAT_RECHECK_MS;
    let wait = REPEAT_RECHECK_MS;
    for (const claim of entry.occurrences.filter(occurrence => occurrence.state === 'claimed')) {
      if (this.disposed) return wait;
      wait = Math.min(wait, await this.resolveClaim(projectId, source, claim, eligible, digest));
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
      wait = Math.min(wait, await this.run(projectId, source, claim, digest));
    }
    return wait;
  }

  /**
   * A claim left open (a crash, a lost reply). Recorded by the flow service: replay it, whatever the time.
   * Not recorded: nothing started, so it runs only as a first try would (still on, within the window); one whose
   * time has not come yet (the clock went back) waits for it. Returns how long until it needs another look.
   */
  private async resolveClaim(projectId: string, source: WorkflowRepeatSource, claim: Occurrence, eligible: boolean, config: string): Promise<number> {
    let receipt: WorkflowLaunchReceipt;
    try { receipt = await this.options.launchReceipt(projectId, claim.commandId); } catch (error) { this.options.reportError?.(error); return RETRY_MS; }
    // Settled: the replay only answers from its record. Pending: a replay runs what the flow file recorded, so only
    // if that is what this host claimed (the file sits in the project folder).
    if (receipt.state === 'settled') return this.run(projectId, source, claim);
    if (receipt.state === 'pending') {
      if (claim.intent && receipt.intent === claim.intent) return this.run(projectId, source, claim);
      await this.record(projectId, source.subprojectId, { ...claim, state: 'failed', at: this.now().toISOString(),
        detail: 'The flow file changed outside this host after this occurrence was sent; it was not run again.' });
      return Number.POSITIVE_INFINITY;
    }
    const entry = this.entries.get(entryKey(projectId, source.subprojectId));
    const armedAt = entry?.armed ? Date.parse(entry.armed.armedAt) : Number.POSITIVE_INFINITY;
    const occurrenceAt = Date.parse(claim.occurrenceAt);
    const age = this.now().getTime() - occurrenceAt;
    if (age < 0) return -age;
    if (eligible && source.reviewer && occurrenceAt >= armedAt && age <= REPEAT_GRACE_MS) return this.run(projectId, source, claim, config);
    await this.record(projectId, source.subprojectId, { ...claim, state: 'missed', at: this.now().toISOString(),
      detail: eligible ? 'The run could not start within 30 minutes of this time.' : 'The repeat was turned off before the run started.' });
    return Number.POSITIVE_INFINITY;
  }

  /**
   * Launches a claim, or replays a recorded one (`config` absent). Returns how long until it needs another look
   * (Infinity once settled).
   */
  private async run(projectId: string, source: WorkflowRepeatSource, claim: Occurrence, config?: string): Promise<number> {
    // Automation can be switched off while the claim was being saved: then nothing is sent and the claim waits.
    if (!this.sampleAutomation() || this.disposed) return RETRY_MS;
    if (config !== undefined) {
      // A first send, checked again right before it against what may have changed while the claim was saved: still
      // confirmed, still armed for this occurrence, automation on since before it. Otherwise it waits (then is missed).
      const entry = this.entries.get(entryKey(projectId, source.subprojectId));
      const occurrenceAt = Date.parse(claim.occurrenceAt);
      if (entry?.consent?.contentDigest !== source.contentDigest || entry.armed?.configDigest !== config
        || Date.parse(entry.armed.armedAt) > occurrenceAt || (this.automationOnSince ?? Number.POSITIVE_INFINITY) > occurrenceAt || !source.reviewer) return RETRY_MS;
      const intent = launchIntentDigest(source.contentDigest, { runId: claim.runId, reviewer: source.reviewer });
      if (claim.intent !== intent) claim = await this.record(projectId, source.subprojectId, { ...claim, intent });
    }
    let result: WorkflowResult;
    try {
      // What this host claimed is checked again where it runs (a change in the project folder after this check is refused there).
      result = await this.options.launch({ type: 'run.launch', hostId: this.options.hostId, projectId, subprojectId: source.subprojectId,
        commandId: claim.commandId, expectedRevision: source.revision, payload: { runId: claim.runId } }, REPEAT_SCHEDULE_PRINCIPAL,
      claim.intent ? { launchIntent: claim.intent } : undefined);
    } catch (error) {
      result = { ok: false, error: 'execution-unavailable', message: error instanceof Error ? error.message : String(error) };
    }
    // Unknown outcome or a flow edited since it was read: the claim stays and is looked at again.
    if (!result.ok && ['execution-unavailable', 'revision-conflict', 'unavailable'].includes(result.error)) return RETRY_MS;
    const at = this.now().toISOString();
    await this.record(projectId, source.subprojectId, result.ok ? { ...claim, state: 'started', at, detail: undefined }
      : { ...claim, state: result.error === 'active-run' ? 'skipped-running' : 'failed', at, detail: result.message.slice(0, 500) });
    return Number.POSITIVE_INFINITY;
  }

  private async record(projectId: string, subprojectId: string, occurrence: Occurrence): Promise<Occurrence> {
    await this.update(projectId, subprojectId, entry => ({ ...entry, occurrences: [...entry.occurrences.filter(item => item.key !== occurrence.key), stripUndefined(occurrence)] }));
    return occurrence;
  }

  /**
   * Saved before it is used: the record on disk is never behind what the schedule acted on. One change at a
   * time, each made to the record as the last one left it (a person's consent and a tick never overwrite each
   * other), and never over a record someone else changed into one that cannot be read.
   */
  private update(projectId: string, subprojectId: string, change: (entry: Entry) => Entry): Promise<Entry> {
    return this.file.enqueue(async () => {
      if (!await this.syncNow()) throw new Error('The repeat record cannot be read; it was left as it is and 반복 is stopped.');
      const key = entryKey(projectId, subprojectId);
      const current = this.entries.get(key) ?? { projectId, subprojectId, occurrences: [] };
      const changed = change(current);
      if (changed === current) return current;
      const open = changed.occurrences.filter(occurrence => occurrence.state === 'claimed');
      const settled = changed.occurrences.filter(occurrence => occurrence.state !== 'claimed').sort(byTime).slice(-REPEAT_HISTORY_LIMIT);
      const saved: Entry = stripUndefined({ ...changed, occurrences: [...settled, ...open].sort(byTime) });
      const next = new Map(this.entries).set(key, saved);
      const text = `${JSON.stringify({ version: 1, entries: [...next.values()] }, null, 2)}\n`;
      await this.file.write(text);
      this.known = text;
      this.entries = next;
      this.options.onChanged?.(projectId);
      return saved;
    });
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

/**
 * The record on disk: one writer (this queue), each version written to a temporary file, flushed, then renamed over
 * the record (a crash leaves the old or the new one whole). Plain JSON in the user data folder, like the host's other
 * settings; what it protects against is a flow file from the project folder, which never writes here.
 */
class RecordFile {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string) {}

  enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Creates the folder and clears temporary files a crash left behind. */
  async init(): Promise<void> {
    const directory = path.dirname(this.path);
    await fs.mkdir(directory, { recursive: true });
    const prefix = `${path.basename(this.path)}.`;
    for (const name of await fs.readdir(directory)) {
      if (name.startsWith(prefix) && name.endsWith('.tmp')) await fs.rm(path.join(directory, name), { force: true });
    }
  }

  async read(): Promise<string | undefined> {
    try { return await fs.readFile(this.path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }

  async write(text: string): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    try {
      // One retry: a scanner or indexer can hold the record for a moment on Windows.
      await fs.rename(temporary, this.path).catch(async () => { await new Promise(resolve => setTimeout(resolve, 50)); await fs.rename(temporary, this.path); });
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }
}
function entryKey(projectId: string, subprojectId: string): string { return `${projectId}\n${subprojectId}`; }
function byTime(left: Occurrence, right: Occurrence): number { return Date.parse(left.occurrenceAt) - Date.parse(right.occurrenceAt) || Date.parse(left.at) - Date.parse(right.at); }
function latest(entry: Entry | undefined): Occurrence | undefined { return entry?.occurrences.slice().sort(byTime).at(-1); }
function stripUndefined<T extends object>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
