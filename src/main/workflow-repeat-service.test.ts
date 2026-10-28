import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowCommand, WorkflowPrincipal, WorkflowRegistry, WorkflowRepeat, WorkflowResult } from '../shared/workflow';
import { REPEAT_FILE, REPEAT_HISTORY_LIMIT, WorkflowRepeatService, repeatOccurrenceIds } from './workflow-repeat-service';
import { repeatConfigDigest as configOf } from './workflow-repeat-time';
import { launchIntentDigest, repeatContentDigest, repeatPin, type WorkflowLaunchReceipt, type WorkflowRepeatSource } from './workflow-service';

const seoulNine: WorkflowRepeat = { cadence: 'daily', time: '09:00', timezone: 'Asia/Seoul', enabled: true };
const at = (iso: string) => new Date(iso);
type TestSource = Omit<WorkflowRepeatSource, 'contentDigest' | 'pinnable'>;

describe('WorkflowRepeatService', () => {
  let directory: string;
  let clock: Date;
  let auto: boolean;
  let source: TestSource;
  /** The flow's goal: content a pull could change without this host. */
  let goal: string;
  /** The flow service's receipts: written before any effect, left pending when the outcome is unknown. */
  let receipts: Map<string, { pending: boolean; intent?: string }>;
  let respond: (command: WorkflowCommand) => WorkflowResult;
  let launch: ReturnType<typeof vi.fn<(command: WorkflowCommand, principal: WorkflowPrincipal, expected?: { readonly launchIntent?: string; readonly pinned?: { readonly goal: string } }) => Promise<WorkflowResult>>>;
  let timers: number[];
  let changed: string[];
  let onSaved: (() => void) | undefined;
  let readSources: () => Promise<void>;
  const services: WorkflowRepeatService[] = [];
  const started = { ok: true, snapshot: {} } as unknown as WorkflowResult;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-repeat-'));
    clock = at('2026-10-25T00:00:00.000Z'); // 09:00 in Seoul
    auto = true; goal = '';
    source = { subprojectId: 'flow', revision: 3, status: 'active', repeat: seoulNine, reviewer: { providerId: 'codex', model: 'model' } };
    receipts = new Map();
    respond = () => started;
    // The flow service records a launch (what it runs) before its effect; a refusal before any effect leaves none.
    launch = vi.fn(async (command: WorkflowCommand) => {
      const result = respond(command);
      if (result.ok || result.error !== 'revision-conflict') {
        receipts.set(command.commandId, { pending: !result.ok && result.error === 'execution-unavailable',
          intent: launchIntentDigest(contentOf(), { runId: (command.payload as { runId: string }).runId, reviewer: source.reviewer! }) });
      }
      return result;
    });
    timers = []; changed = []; onSaved = undefined; readSources = async () => undefined;
  });
  afterEach(async () => {
    await Promise.all(services.splice(0).map(service => service.dispose()));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const registry = (): WorkflowRegistry => ({ schemaVersion: 1, projectId: 'project', registryRevision: 1, sessionLinks: [], legacyBaselineOwners: {},
    subprojects: [{ id: 'flow', title: 'Flow', goal, status: source.status, revision: source.revision, createdAt: clock.toISOString(), updatedAt: clock.toISOString(),
      presetId: 'feature', graph: { nodes: [], edges: [], entryNodeId: null } as never, history: [], archivedNodes: [], repeat: source.repeat,
      ...(source.reviewer ? { runSettings: { reviewer: source.reviewer } } : {}) }] });
  /** What the saved flow is now, as the flow service digests it. */
  const contentOf = () => repeatContentDigest(registry().subprojects[0]!);
  function service(): WorkflowRepeatService {
    const created = new WorkflowRepeatService({
      directory, hostId: 'host', projectIds: () => ['project'],
      sources: async () => { const read = [{ ...structuredClone(source), contentDigest: contentOf(), pinnable: repeatPin(registry().subprojects[0]!) }]; await readSources(); return read; },
      launchReceipt: async (_projectId, commandId) => receiptOf(commandId), launch,
      automationEnabled: () => auto, now: () => clock, onChanged: projectId => { changed.push(projectId); onSaved?.(); },
      setTimer: (_run, ms) => { timers.push(ms); return ms; }, clearTimer: () => undefined,
    });
    services.push(created);
    return created;
  }
  const status = (repeat: WorkflowRepeatService) => repeat.status(registry()).flow;
  const receiptOf = (commandId: string): WorkflowLaunchReceipt => {
    const receipt = receipts.get(commandId);
    return !receipt ? { state: 'none' } : receipt.pending ? { state: 'pending', ...(receipt.intent ? { intent: receipt.intent } : {}) } : { state: 'settled' };
  };
  /** What the flow service tells the schedule after saving: a person's 반복 save (no `before`) or another edit. */
  const saved = (repeat: WorkflowRepeatService, before?: string) => repeat.consent('project', 'flow', { set: before === undefined, ...(before ? { before } : {}),
    ...(source.repeat.enabled ? { after: contentOf(), ...(before === undefined ? { pinned: repeatPin(registry().subprojects[0]!) } : {}) } : {}),
    config: configOf(source.repeat), runnable: source.repeat.enabled && source.status === 'active' });
  /** A person turns the repeat on through this host at `iso`. */
  async function armedAt(iso: string): Promise<WorkflowRepeatService> {
    const now = clock; clock = at(iso);
    const repeat = service(); await saved(repeat); await repeat.start();
    clock = now;
    return repeat;
  }
  /** A person saves a changed 반복. */
  async function setRepeat(repeat: WorkflowRepeatService, next: WorkflowRepeat): Promise<void> {
    source = { ...source, repeat: next };
    await saved(repeat);
  }
  /** Any other edit of the flow made through this host. */
  async function edit(repeat: WorkflowRepeatService, change: () => void): Promise<void> {
    const before = contentOf();
    change();
    await saved(repeat, before);
  }
  const record = async () => JSON.parse(await fs.readFile(path.join(directory, REPEAT_FILE), 'utf8')) as {
    entries: { projectId: string; consent?: { contentDigest: string }; armed?: { armedAt: string }; occurrences: { key: string; state: string }[] }[] };

  it('runs the saved flow at its local time under ids fixed by its day, once per day', async () => {
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    expect(launch).not.toHaveBeenCalled();
    expect(timers.at(-1)).toBe(5 * 60_000); // the wall clock is read again at least every five minutes
    clock = at('2026-10-25T00:00:05.000Z');
    await repeat.wake();
    const ids = repeatOccurrenceIds('project', 'flow', '2026-10-25');
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]!.slice(0, 2)).toEqual([{ type: 'run.launch', hostId: 'host', projectId: 'project', subprojectId: 'flow', commandId: ids.commandId, expectedRevision: 3, payload: { runId: ids.runId } },
      { kind: 'schedule', id: 'workflow-schedule' }]);
    expect(ids.commandId).toMatch(/^schedule-[0-9a-f]{40}$/u);
    // It names what it decided to run, and the flow service checks that where it runs.
    // It runs the flow the person confirmed (decision 8), named by the same intent.
    expect(launch.mock.calls[0]![2]).toEqual({ launchIntent: launchIntentDigest(contentOf(), { runId: ids.runId, reviewer: source.reviewer! }), pinned: expect.objectContaining({ id: 'flow', goal: '' }) });
    expect(status(repeat)).toEqual({ nextAt: '2026-10-26T00:00:00.000Z', last: { key: '2026-10-25', occurrenceAt: '2026-10-25T00:00:00.000Z', state: 'started', at: '2026-10-25T00:00:05.000Z', runId: ids.runId } });
    clock = at('2026-10-25T00:10:00.000Z');
    await repeat.wake();
    // A host that restarts reads the same day as done.
    await repeat.dispose();
    await service().start();
    expect(launch).toHaveBeenCalledOnce();
    expect(changed).toContain('project');
  });

  it('runs an occurrence right after it was turned on, even when the first look comes after its time', async () => {
    source = { ...source, repeat: { ...seoulNine, enabled: false } };
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    // Turned on at 08:59:59 (armed at that save); the schedule looks again only at 09:00:01.
    clock = at('2026-10-24T23:59:59.000Z'); await setRepeat(repeat, seoulNine);
    clock = at('2026-10-25T00:00:01.000Z'); await repeat.wake();
    expect(launch).toHaveBeenCalledOnce();
  });

  it('records a day the flow was still running, and does not try it again', async () => {
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    respond = () => ({ ok: false, error: 'active-run', message: 'This flow is still running.' });
    clock = at('2026-10-25T00:01:00.000Z');
    await repeat.wake();
    expect(status(repeat)?.last).toMatchObject({ state: 'skipped-running', detail: 'This flow is still running.' });
    respond = () => started;
    clock = at('2026-10-25T00:20:00.000Z');
    await repeat.wake();
    expect(launch).toHaveBeenCalledOnce();
  });

  it('runs a late occurrence within 30 minutes and records a later one as missed, counting the days', async () => {
    let repeat = await armedAt('2026-10-24T23:00:00.000Z');
    await repeat.dispose();
    clock = at('2026-10-25T00:29:00.000Z');
    repeat = service(); await repeat.start();
    expect(launch).toHaveBeenCalledOnce();
    await repeat.dispose();
    // Off for three more mornings: one missed record for the last of them.
    clock = at('2026-10-28T02:00:00.000Z');
    repeat = service(); await repeat.start();
    expect(launch).toHaveBeenCalledOnce();
    expect(status(repeat)).toMatchObject({ nextAt: '2026-10-29T00:00:00.000Z', last: { key: '2026-10-28', state: 'missed', missedCount: 3 } });
  });

  it('measures the window from the real time a spring-forward moves an occurrence to, and runs a repeated fall-back time once', async () => {
    source = { ...source, repeat: { cadence: 'daily', time: '02:30', timezone: 'America/New_York', enabled: true } };
    // 2026-03-08 New York: 02:30 does not exist; it runs at 03:30 EDT (07:30Z).
    let repeat = await armedAt('2026-03-08T05:00:00.000Z');
    await repeat.dispose();
    clock = at('2026-03-08T07:59:00.000Z');
    repeat = service(); await repeat.start();
    expect(launch).toHaveBeenCalledOnce();
    expect(status(repeat)?.last).toMatchObject({ key: '2026-03-08', occurrenceAt: '2026-03-08T07:30:00.000Z', state: 'started' });
    // 2026-11-01 New York: 01:30 happens at 05:30Z and again at 06:30Z; only the first runs.
    clock = at('2026-11-01T04:00:00.000Z'); await setRepeat(repeat, { ...source.repeat, time: '01:30' });
    clock = at('2026-11-01T05:30:10.000Z'); await repeat.wake();
    clock = at('2026-11-01T06:30:10.000Z'); await repeat.wake();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(status(repeat)).toMatchObject({ nextAt: '2026-11-02T06:30:00.000Z', last: { key: '2026-11-01', occurrenceAt: '2026-11-01T05:30:00.000Z' } });
  });

  it('keys an occurrence by its local date across midnight, and a clock set back does not run a day twice', async () => {
    source = { ...source, repeat: { ...seoulNine, time: '00:10' } };
    const repeat = await armedAt('2026-10-25T14:00:00.000Z'); // 23:00 in Seoul
    clock = at('2026-10-25T15:10:30.000Z'); await repeat.wake();
    expect(status(repeat)?.last).toMatchObject({ key: '2026-10-26', state: 'started' });
    clock = at('2026-10-25T14:30:00.000Z'); await repeat.wake();
    clock = at('2026-10-25T15:10:30.000Z'); await repeat.wake();
    expect(launch).toHaveBeenCalledOnce();
  });

  it('never runs an occurrence from before it was turned on, changed or turned back on', async () => {
    // Turned on at 09:10 for 09:00: not today.
    const repeat = await armedAt('2026-10-25T00:10:00.000Z');
    expect(launch).not.toHaveBeenCalled();
    expect(status(repeat)?.nextAt).toBe('2026-10-26T00:00:00.000Z');
    // Off before 09:00 the next day and back on at 09:05: not that day either.
    clock = at('2026-10-25T23:50:00.000Z'); await setRepeat(repeat, { ...seoulNine, enabled: false }); await repeat.wake();
    expect(status(repeat)).toEqual({});
    clock = at('2026-10-26T00:05:00.000Z'); await setRepeat(repeat, seoulNine); await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    // Changed to 09:30 at 09:05: it runs at 09:30.
    await setRepeat(repeat, { ...seoulNine, time: '09:30' });
    await repeat.wake();
    clock = at('2026-10-26T00:30:01.000Z'); await repeat.wake();
    expect(launch).toHaveBeenCalledOnce();
    // Moved to 11:00 after that day's run: still one run that day.
    clock = at('2026-10-26T01:00:00.000Z'); await setRepeat(repeat, { ...seoulNine, time: '11:00' }); await repeat.wake();
    clock = at('2026-10-26T02:00:01.000Z'); await repeat.wake();
    expect(launch).toHaveBeenCalledOnce();
  });

  it('runs a missed day once its time is moved later that day', async () => {
    let repeat = await armedAt('2026-10-24T23:00:00.000Z');
    await repeat.dispose();
    clock = at('2026-10-25T01:05:00.000Z');
    repeat = service(); await repeat.start();
    expect(status(repeat)?.last).toMatchObject({ key: '2026-10-25', state: 'missed' });
    await setRepeat(repeat, { ...seoulNine, time: '11:00' });
    await repeat.wake();
    clock = at('2026-10-25T02:00:01.000Z'); await repeat.wake();
    expect(launch).toHaveBeenCalledOnce();
    expect(status(repeat)?.last).toMatchObject({ key: '2026-10-25', state: 'started' });
  });

  it('does not run a completed or archived flow, and a flow restored after its time waits for the next one', async () => {
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    clock = at('2026-10-24T23:30:00.000Z'); await edit(repeat, () => { source = { ...source, status: 'completed' }; });
    clock = at('2026-10-25T00:00:05.000Z'); await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    expect(status(repeat)?.nextAt).toBeUndefined();
    await edit(repeat, () => { source = { ...source, status: 'archived' }; });
    clock = at('2026-10-26T00:00:05.000Z'); await repeat.wake();
    // Restored after its time: that occurrence never runs.
    clock = at('2026-10-26T00:10:00.000Z'); await edit(repeat, () => { source = { ...source, status: 'active' }; }); await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    clock = at('2026-10-27T00:00:05.000Z'); await repeat.wake();
    expect(launch).toHaveBeenCalledOnce();
  });

  it('replays a claim the flow service recorded whatever the time, and starts no second run', async () => {
    let repeat = await armedAt('2026-10-24T23:00:00.000Z');
    // The reply is lost: the claim stays open and is looked at again in a minute.
    respond = () => ({ ok: false, error: 'execution-unavailable', message: 'The host was unreachable.' });
    clock = at('2026-10-25T00:00:05.000Z'); await repeat.wake();
    expect(status(repeat)?.last).toMatchObject({ state: 'claimed' });
    expect(timers.at(-1)).toBe(60_000);
    await repeat.dispose();
    respond = () => started;
    clock = at('2026-10-25T03:00:00.000Z');
    repeat = service(); await repeat.start();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[1]![0]).toEqual(launch.mock.calls[0]![0]);
    expect(status(repeat)?.last).toMatchObject({ key: '2026-10-25', state: 'started' });
  });

  /** A record with one claim the flow service never recorded (a crash between the claim and the launch). */
  const writeClaim = (armedAt: string) => fs.writeFile(path.join(directory, REPEAT_FILE), JSON.stringify({ version: 1, entries: [{ projectId: 'project', subprojectId: 'flow',
    consent: { contentDigest: contentOf(), at: armedAt }, armed: { configDigest: configOf(seoulNine), armedAt },
    occurrences: [{ key: '2026-10-25', occurrenceAt: '2026-10-25T00:00:00.000Z', state: 'claimed', at: '2026-10-25T00:00:01.000Z', ...repeatOccurrenceIds('project', 'flow', '2026-10-25') }] }] }));

  it('runs an unrecorded claim within the window under the same ids, and records a later one as missed', async () => {
    const ids = repeatOccurrenceIds('project', 'flow', '2026-10-25');
    await writeClaim('2026-10-24T23:00:00.000Z');
    clock = at('2026-10-25T00:20:00.000Z');
    let repeat = service(); await repeat.start();
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]![0]).toMatchObject({ commandId: ids.commandId, payload: { runId: ids.runId } });
    await repeat.dispose();
    launch.mockClear(); receipts.clear();
    await writeClaim('2026-10-24T23:00:00.000Z');
    clock = at('2026-10-25T00:31:00.000Z');
    repeat = service(); await repeat.start();
    expect(launch).not.toHaveBeenCalled();
    expect(status(repeat)?.last).toMatchObject({ key: '2026-10-25', state: 'missed' });
  });

  it('keeps an unrecorded claim whose time has not come (the clock went back) and runs it at its time', async () => {
    await writeClaim('2026-10-24T23:00:00.000Z');
    clock = at('2026-10-24T23:30:00.000Z');
    const repeat = service(); await repeat.start();
    expect(launch).not.toHaveBeenCalled();
    expect(status(repeat)?.last).toMatchObject({ key: '2026-10-25', state: 'claimed' });
    expect(timers.at(-1)).toBe(5 * 60_000);
    clock = at('2026-10-25T00:00:10.000Z'); await repeat.wake();
    expect(launch).toHaveBeenCalledOnce();
    expect(status(repeat)?.last).toMatchObject({ key: '2026-10-25', state: 'started' });
  });

  it('runs again a claim refused because the flow changed since it was read, and records a final refusal as failed', async () => {
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    respond = () => ({ ok: false, error: 'revision-conflict', message: 'The workflow changed.', revision: 4 });
    launch.mockImplementationOnce(async (command) => respond(command)); // refused before any receipt
    clock = at('2026-10-25T00:00:05.000Z'); await repeat.wake();
    respond = () => ({ ok: false, error: 'invalid-graph', message: 'Resolve the highlighted stages before preparing this execution.' });
    source = { ...source, revision: 4 };
    clock = at('2026-10-25T00:01:05.000Z'); await repeat.wake();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[1]![0]).toMatchObject({ expectedRevision: 4 });
    expect(status(repeat)?.last).toMatchObject({ state: 'failed', detail: 'Resolve the highlighted stages before preparing this execution.' });
  });

  it('stops every repeat while its record cannot be read, and leaves that file as it was', async () => {
    const file = path.join(directory, REPEAT_FILE);
    await fs.writeFile(file, '{"version":1,"entries":[{"broken"');
    const reportError = vi.fn();
    const repeat = new WorkflowRepeatService({ directory, hostId: 'host', projectIds: () => ['project'],
      sources: async () => [{ ...source, contentDigest: contentOf(), pinnable: repeatPin(registry().subprojects[0]!) }], launchReceipt: async () => ({ state: 'none' }), launch, automationEnabled: () => true, now: () => clock, reportError,
      setTimer: () => 0, clearTimer: () => undefined });
    services.push(repeat);
    clock = at('2026-10-25T00:00:05.000Z'); await repeat.start(); await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    expect(status(repeat)).toEqual({ blocked: 'unreadable' });
    expect(await fs.readFile(file, 'utf8')).toBe('{"version":1,"entries":[{"broken"');
    expect(reportError).toHaveBeenCalledOnce();
    // A person's save cannot write over it either.
    await expect(saved(repeat)).rejects.toThrow('cannot be read');
    expect(await fs.readFile(file, 'utf8')).toBe('{"version":1,"entries":[{"broken"');
    // Moved aside by the person: the record (and every consent in it) starts empty, so 반복 is turned on again.
    await fs.rm(file);
    await repeat.wake();
    expect(status(repeat)).toEqual({ blocked: 'unconfirmed' });
    await saved(repeat);
    expect(status(repeat)).toEqual({ nextAt: '2026-10-26T00:00:00.000Z' });
  });

  it('notices a record broken while it runs and leaves it as it is; a valid one changed elsewhere is read again', async () => {
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    const file = path.join(directory, REPEAT_FILE);
    const good = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, 'not json');
    clock = at('2026-10-25T00:00:05.000Z'); await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    expect(await fs.readFile(file, 'utf8')).toBe('not json');
    expect(status(repeat)).toEqual({ blocked: 'unreadable' });
    await fs.writeFile(file, good);
    await repeat.wake();
    expect(launch).toHaveBeenCalledOnce();
  });

  it('does not run while automation is off, and counts from when it is turned back on', async () => {
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    auto = false;
    clock = at('2026-10-25T00:00:05.000Z'); await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    expect(status(repeat)).toEqual({ blocked: 'automation-off' });
    auto = true;
    clock = at('2026-10-25T00:10:00.000Z'); await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    expect(status(repeat)).toEqual({ nextAt: '2026-10-26T00:00:00.000Z' });
  });

  it('sends nothing when automation is turned off while a claim is being saved', async () => {
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    onSaved = () => { if (status(repeat)?.last?.state === 'claimed') auto = false; };
    clock = at('2026-10-25T00:00:05.000Z'); await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    expect(status(repeat)?.last).toMatchObject({ state: 'claimed' });
    // Back on later: the claim was before that, so it is missed (no receipt, nothing ran).
    onSaved = undefined; auto = true;
    clock = at('2026-10-25T00:05:00.000Z'); await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    expect(status(repeat)?.last).toMatchObject({ key: '2026-10-25', state: 'missed' });
  });

  it('sees automation switched off and back on while it is still reading the flows', async () => {
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    let release!: () => void;
    readSources = () => new Promise<void>(resolve => { release = resolve; });
    clock = at('2026-10-25T00:00:05.000Z');
    const looking = repeat.wake();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    auto = false; void repeat.wake();
    clock = at('2026-10-25T00:00:06.000Z'); auto = true; void repeat.wake();
    readSources = async () => undefined;
    release(); await looking;
    expect(launch).not.toHaveBeenCalled();
    expect((await record()).entries[0]!.armed?.armedAt).toBe('2026-10-25T00:00:06.000Z');
    expect(status(repeat)?.nextAt).toBe('2026-10-26T00:00:00.000Z');
  });

  it('does not run a repeat that came with the project folder until a person turns it on here', async () => {
    // The flow file (in the project folder) says 반복 is on, but nobody turned it on through this host.
    const repeat = service();
    clock = at('2026-10-24T23:00:00.000Z'); await repeat.start();
    clock = at('2026-10-25T00:00:05.000Z'); await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    expect(status(repeat)).toEqual({ blocked: 'unconfirmed' });
    // Turned on here: it runs from then on (not the occurrence before it).
    await saved(repeat);
    await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    clock = at('2026-10-26T00:00:05.000Z'); await repeat.wake();
    expect(launch).toHaveBeenCalledOnce();
    // Turned off here: the consent goes with it, so the file alone cannot turn it back on.
    await setRepeat(repeat, { ...seoulNine, enabled: false });
    source = { ...source, repeat: seoulNine };
    clock = at('2026-10-27T00:00:05.000Z'); await repeat.wake();
    expect(launch).toHaveBeenCalledOnce();
    expect(status(repeat)?.blocked).toBe('unconfirmed');
  });

  it('keeps running the flow the person confirmed: an edit here or a pull waits for a new confirmation (decision 8)', async () => {
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    // An edit through this host (here: the goal) does not reach the schedule: it runs what was confirmed.
    await edit(repeat, () => { goal = 'Ship the login fix'; });
    clock = at('2026-10-25T00:00:05.000Z'); await repeat.wake();
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]![2]?.pinned).toMatchObject({ goal: '' });
    // A pull changes the flow in the project folder: still only the confirmed flow runs.
    goal = 'Delete everything';
    clock = at('2026-10-26T00:00:05.000Z'); await repeat.wake();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[1]![2]?.pinned).toMatchObject({ goal: '' });
    expect(status(repeat)?.blocked).toBeUndefined();
    // Confirmed again here (켜기): it repeats the flow as it is now.
    await saved(repeat);
    clock = at('2026-10-27T00:00:05.000Z'); await repeat.wake();
    expect(launch).toHaveBeenCalledTimes(3);
    expect(launch.mock.calls[2]![2]?.pinned).toMatchObject({ goal: 'Delete everything' });
  });

  it('keeps a person’s consent and a tick’s claim when they are saved at the same moment', async () => {
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    let release!: () => void;
    launch.mockImplementationOnce(async (command) => { receipts.set(command.commandId, { pending: false }); await new Promise<void>(resolve => { release = resolve; }); return started; });
    clock = at('2026-10-25T00:00:05.000Z');
    const ticking = repeat.wake();
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    await repeat.consent('other-project', 'flow', { set: true, after: 'a'.repeat(64), config: configOf(seoulNine), runnable: true });
    release(); await ticking;
    await repeat.dispose();
    const file = await record();
    expect(file.entries.find(entry => entry.projectId === 'other-project')?.consent).toBeDefined();
    expect(file.entries.find(entry => entry.projectId === 'project')?.occurrences.at(-1)?.state).toBe('started');
  });

  it('clears what a crash left mid-save and keeps the last whole record', async () => {
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    await repeat.dispose();
    const whole = await fs.readFile(path.join(directory, REPEAT_FILE), 'utf8');
    const leftover = path.join(directory, `${REPEAT_FILE}.0c8e0d2e-crash.tmp`);
    await fs.writeFile(leftover, '{"version":1,"entr');
    await fs.writeFile(path.join(directory, 'other-store.json.tmp'), 'not ours');
    clock = at('2026-10-25T00:00:05.000Z');
    await service().start();
    await expect(fs.stat(leftover)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(directory, 'other-store.json.tmp'), 'utf8')).toBe('not ours');
    expect(launch).toHaveBeenCalledOnce();
    expect(JSON.parse(await fs.readFile(path.join(directory, REPEAT_FILE), 'utf8'))).toMatchObject({ version: 1 });
    expect(whole).not.toBe('');
  });

  it('does not replay a sent occurrence whose recorded flow was changed in the project folder', async () => {
    let repeat = await armedAt('2026-10-24T23:00:00.000Z');
    respond = () => ({ ok: false, error: 'execution-unavailable', message: 'The provider was unreachable.' });
    clock = at('2026-10-25T00:00:05.000Z'); await repeat.wake();
    expect(launch).toHaveBeenCalledOnce();
    await repeat.dispose();
    // While the host is down, the flow file's pending receipt is rewritten to run other instructions.
    const ids = repeatOccurrenceIds('project', 'flow', '2026-10-25');
    receipts.set(ids.commandId, { pending: true, intent: 'f'.repeat(64) });
    respond = () => started;
    clock = at('2026-10-25T00:10:00.000Z');
    repeat = service(); await repeat.start();
    expect(launch).toHaveBeenCalledOnce();
    expect(status(repeat)?.last).toMatchObject({ key: '2026-10-25', state: 'failed', detail: expect.stringContaining('changed outside this host') });
  });

  it('sends nothing for an occurrence from before automation was switched off and on while its claim was saved', async () => {
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    onSaved = () => {
      if (status(repeat)?.last?.state !== 'claimed' || onSaved === undefined) return;
      onSaved = undefined;
      auto = false; void repeat.wake();
      clock = at('2026-10-25T00:00:06.000Z'); auto = true; void repeat.wake();
    };
    clock = at('2026-10-25T00:00:05.000Z'); await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    expect(status(repeat)?.last).toMatchObject({ key: '2026-10-25', state: 'missed' });
  });

  it('keeps a consent a person saved while the schedule was reading an older copy of the flow', async () => {
    source = { ...source, repeat: { ...seoulNine, enabled: false } };
    const repeat = await armedAt('2026-10-24T22:00:00.000Z');
    clock = at('2026-10-24T23:00:00.000Z');
    // The schedule reads the flow (still off); before it decides, the person turns 반복 on.
    readSources = async () => { readSources = async () => undefined; clock = at('2026-10-24T23:00:02.000Z'); await setRepeat(repeat, seoulNine); };
    await repeat.wake();
    expect((await record()).entries[0]!.consent).toBeDefined();
    expect(status(repeat)).toEqual({ nextAt: '2026-10-25T00:00:00.000Z' });
    clock = at('2026-10-25T00:00:05.000Z'); await repeat.wake();
    expect(launch).toHaveBeenCalledOnce();
  });

  it('checks again after saving what it is about to send: automation switched off and on then sends nothing', async () => {
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    let saves = 0;
    // The second save of this occurrence is its intent, right before the send.
    onSaved = () => {
      if (status(repeat)?.last?.state !== 'claimed' || ++saves !== 2) return;
      auto = false; void repeat.wake();
      clock = at('2026-10-25T00:00:06.000Z'); auto = true; void repeat.wake();
    };
    clock = at('2026-10-25T00:00:05.000Z'); await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    expect(status(repeat)?.last).toMatchObject({ key: '2026-10-25', state: 'missed' });
  });

  it('keeps the arming an edit made here moved along while the schedule was reading an older copy', async () => {
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    clock = at('2026-10-25T00:00:05.000Z');
    // The schedule reads the flow; before it decides, the person edits the flow here (the consent follows, the arming stays).
    readSources = async () => { readSources = async () => undefined; await edit(repeat, () => { goal = 'Edited here'; }); };
    await repeat.wake();
    expect((await record()).entries[0]!.armed?.armedAt).toBe('2026-10-24T23:00:00.000Z');
    // The next look (with the fresh flow) runs the 09:00 occurrence.
    await repeat.wake();
    expect(launch).toHaveBeenCalledOnce();
  });

  it('counts a flow confirmed again (after a change outside this host) from that confirmation', async () => {
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    goal = 'Changed by a pull';
    // Confirmed again at 09:05 before any look: the 09:00 occurrence, before it, does not run.
    clock = at('2026-10-25T00:05:00.000Z'); await saved(repeat); await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    expect(status(repeat)?.nextAt).toBe('2026-10-26T00:00:00.000Z');
  });

  it('names the review AI it needs before it can run', async () => {
    source = { ...source, reviewer: undefined };
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    clock = at('2026-10-25T00:00:05.000Z'); await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    expect(status(repeat)).toEqual({ blocked: 'missing-reviewer' });
  });

  it(`keeps the latest ${REPEAT_HISTORY_LIMIT} occurrences and every open claim`, async () => {
    const day = (index: number) => new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
    const occurrences = Array.from({ length: 70 }, (_, index) => ({ key: day(index), occurrenceAt: `${day(index)}T00:00:00.000Z`, state: index === 0 ? 'claimed' : 'started',
      at: `${day(index)}T00:00:01.000Z`, ...repeatOccurrenceIds('project', 'flow', day(index)) }));
    await fs.writeFile(path.join(directory, REPEAT_FILE), JSON.stringify({ version: 1, entries: [{ projectId: 'project', subprojectId: 'flow',
      consent: { contentDigest: contentOf(), at: '2025-12-31T00:00:00.000Z' }, armed: { configDigest: configOf(seoulNine), armedAt: '2025-12-31T00:00:00.000Z' }, occurrences }] }));
    receipts.set(occurrences[0]!.commandId, { pending: false });
    clock = at('2026-03-12T00:00:05.000Z');
    const repeat = service(); await repeat.start();
    await repeat.dispose();
    const file = await record();
    expect(file.entries[0]!.occurrences).toHaveLength(REPEAT_HISTORY_LIMIT);
    expect(file.entries[0]!.occurrences.at(-1)).toMatchObject({ key: '2026-03-12', state: 'started' });
    expect(file.entries[0]!.occurrences.some(occurrence => occurrence.key === day(0))).toBe(false); // the old claim settled by its replay, then aged out
  });
});
