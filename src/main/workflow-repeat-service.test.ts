import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowCommand, WorkflowPrincipal, WorkflowRegistry, WorkflowRepeat, WorkflowResult } from '../shared/workflow';
import { REPEAT_FILE, REPEAT_HISTORY_LIMIT, WorkflowRepeatService, repeatOccurrenceIds } from './workflow-repeat-service';
import { repeatConfigDigest as digestOf } from './workflow-repeat-time';
import type { WorkflowRepeatSource } from './workflow-service';

const seoulNine: WorkflowRepeat = { cadence: 'daily', time: '09:00', timezone: 'Asia/Seoul', enabled: true };
const at = (iso: string) => new Date(iso);

describe('WorkflowRepeatService', () => {
  let directory: string;
  let clock: Date;
  let auto: boolean;
  let source: WorkflowRepeatSource & { reviewer?: { providerId: string; model: string } };
  let receipts: Set<string>;
  let respond: (command: WorkflowCommand) => WorkflowResult;
  let launch: ReturnType<typeof vi.fn<(command: WorkflowCommand, principal: WorkflowPrincipal) => Promise<WorkflowResult>>>;
  let timers: number[];
  let changed: string[];
  const services: WorkflowRepeatService[] = [];
  const started = { ok: true, snapshot: {} } as unknown as WorkflowResult;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-repeat-'));
    clock = at('2026-10-25T00:00:00.000Z'); // 09:00 in Seoul
    auto = true;
    source = { subprojectId: 'flow', revision: 3, status: 'active', repeat: seoulNine, reviewer: { providerId: 'codex', model: 'model' } };
    receipts = new Set();
    respond = () => started;
    // The flow service records a launch before its effect: a later look sees the receipt.
    launch = vi.fn(async (command: WorkflowCommand) => { receipts.add(command.commandId); return respond(command); });
    timers = []; changed = [];
  });
  afterEach(async () => {
    await Promise.all(services.splice(0).map(service => service.dispose()));
    await fs.rm(directory, { recursive: true, force: true });
  });

  function service(): WorkflowRepeatService {
    const created = new WorkflowRepeatService({
      directory, file: { windowsAcl: async () => undefined }, hostId: 'host', projectIds: () => ['project'],
      sources: async () => [structuredClone(source)], hasReceipt: async (_projectId, commandId) => receipts.has(commandId), launch,
      automationEnabled: () => auto, now: () => clock, onChanged: projectId => changed.push(projectId),
      setTimer: (_run, ms) => { timers.push(ms); return ms; }, clearTimer: () => undefined,
    });
    services.push(created);
    return created;
  }
  const registry = (): WorkflowRegistry => ({ schemaVersion: 1, projectId: 'project', registryRevision: 1, sessionLinks: [], legacyBaselineOwners: {},
    subprojects: [{ id: 'flow', title: 'Flow', goal: '', status: source.status, revision: source.revision, createdAt: clock.toISOString(), updatedAt: clock.toISOString(),
      presetId: 'feature', graph: { nodes: [], edges: [], entryNodeId: null } as never, history: [], archivedNodes: [], repeat: source.repeat,
      ...(source.reviewer ? { runSettings: { reviewer: source.reviewer } } : {}) }] });
  const status = (repeat: WorkflowRepeatService) => repeat.status(registry()).flow;
  /** A person turns the repeat on (or changes it) through this host at `iso`: the flow service records consent first. */
  async function armedAt(iso: string): Promise<WorkflowRepeatService> {
    const now = clock; clock = at(iso);
    const repeat = service(); await repeat.consent('project', 'flow', source.repeat); await repeat.start();
    clock = now;
    return repeat;
  }
  /** A person saves a changed 반복, as the flow service does it: consent, then the saved flow. */
  async function setRepeat(repeat: WorkflowRepeatService, next: WorkflowRepeat): Promise<void> {
    await repeat.consent('project', 'flow', next);
    source = { ...source, repeat: next };
  }

  it('runs the saved flow at its local time under ids fixed by its day, once per day', async () => {
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    expect(launch).not.toHaveBeenCalled();
    expect(timers.at(-1)).toBe(5 * 60_000); // the wall clock is read again at least every five minutes
    clock = at('2026-10-25T00:00:05.000Z');
    await repeat.wake();
    const ids = repeatOccurrenceIds('project', 'flow', '2026-10-25');
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]).toEqual([{ type: 'run.launch', hostId: 'host', projectId: 'project', subprojectId: 'flow', commandId: ids.commandId, expectedRevision: 3, payload: { runId: ids.runId } },
      { kind: 'schedule', id: 'workflow-schedule' }]);
    expect(ids.commandId).toMatch(/^schedule-[0-9a-f]{40}$/u);
    expect(status(repeat)).toEqual({ nextAt: '2026-10-26T00:00:00.000Z', last: { key: '2026-10-25', occurrenceAt: '2026-10-25T00:00:00.000Z', state: 'started', at: '2026-10-25T00:00:05.000Z', runId: ids.runId } });
    clock = at('2026-10-25T00:10:00.000Z');
    await repeat.wake();
    // A host that restarts reads the same day as done.
    await repeat.dispose();
    await service().start();
    expect(launch).toHaveBeenCalledOnce();
    expect(changed).toContain('project');
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
    await setRepeat(repeat, { ...source.repeat, time: '01:30' });
    clock = at('2026-11-01T04:00:00.000Z'); await repeat.wake(); // re-armed for the new time
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
    // Off at 09:00 the next day and back on at 09:05: not that day either.
    await setRepeat(repeat, { ...seoulNine, enabled: false });
    clock = at('2026-10-25T23:50:00.000Z'); await repeat.wake();
    expect(status(repeat)).toEqual({});
    await setRepeat(repeat, seoulNine);
    clock = at('2026-10-26T00:05:00.000Z'); await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    // Changed to 09:30 at 09:05: it runs at 09:30.
    await setRepeat(repeat, { ...seoulNine, time: '09:30' });
    await repeat.wake();
    clock = at('2026-10-26T00:30:01.000Z'); await repeat.wake();
    expect(launch).toHaveBeenCalledOnce();
    // Moved to 11:00 after that day's run: still one run that day.
    await setRepeat(repeat, { ...seoulNine, time: '11:00' });
    clock = at('2026-10-26T01:00:00.000Z'); await repeat.wake();
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

  it('does not run a completed or archived flow, and looks again after the PC resumes', async () => {
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    source = { ...source, status: 'completed' };
    clock = at('2026-10-25T00:00:05.000Z'); await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    expect(status(repeat)?.nextAt).toBeUndefined();
    source = { ...source, status: 'archived' };
    clock = at('2026-10-26T00:00:05.000Z'); await repeat.wake();
    // Restored after its time: that occurrence never runs.
    source = { ...source, status: 'active' };
    clock = at('2026-10-26T00:10:00.000Z'); await repeat.wake();
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

  it('runs an unrecorded claim within the window under the same ids, and records a later one as missed', async () => {
    const ids = repeatOccurrenceIds('project', 'flow', '2026-10-25');
    const claimed = (armedAt: string) => fs.writeFile(path.join(directory, REPEAT_FILE), JSON.stringify({ version: 1, entries: [{ projectId: 'project', subprojectId: 'flow',
      consent: { configDigest: digestOf(seoulNine), at: armedAt }, armed: { configDigest: digestOf(seoulNine), armedAt }, occurrences: [{ key: '2026-10-25', occurrenceAt: '2026-10-25T00:00:00.000Z', state: 'claimed', at: '2026-10-25T00:00:01.000Z', ...ids }] }] }));
    await claimed('2026-10-24T23:00:00.000Z');
    clock = at('2026-10-25T00:20:00.000Z');
    let repeat = service(); await repeat.start();
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]![0]).toMatchObject({ commandId: ids.commandId, payload: { runId: ids.runId } });
    await repeat.dispose();
    launch.mockClear(); receipts.clear();
    await claimed('2026-10-24T23:00:00.000Z');
    clock = at('2026-10-25T00:31:00.000Z');
    repeat = service(); await repeat.start();
    expect(launch).not.toHaveBeenCalled();
    expect(status(repeat)?.last).toMatchObject({ key: '2026-10-25', state: 'missed' });
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
    const repeat = new WorkflowRepeatService({ directory, file: { windowsAcl: async () => undefined }, hostId: 'host', projectIds: () => ['project'],
      sources: async () => [source], hasReceipt: async () => false, launch, automationEnabled: () => true, now: () => clock, reportError,
      setTimer: () => 0, clearTimer: () => undefined });
    services.push(repeat);
    clock = at('2026-10-25T00:00:05.000Z'); await repeat.start(); await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    expect(status(repeat)).toEqual({ blocked: 'unreadable' });
    expect(await fs.readFile(file, 'utf8')).toBe('{"version":1,"entries":[{"broken"');
    expect(reportError).toHaveBeenCalledOnce();
    // Moved aside by the person: the record (and every consent in it) starts empty, so 반복 is turned on again.
    await fs.rm(file);
    await repeat.wake();
    expect(status(repeat)).toEqual({ blocked: 'unconfirmed' });
    await repeat.consent('project', 'flow', seoulNine);
    expect(status(repeat)).toEqual({ nextAt: '2026-10-26T00:00:00.000Z' });
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

  it('does not run a repeat that came with the project folder until a person turns it on here', async () => {
    // The flow file (in the project folder) says 반복 is on, but nobody turned it on through this host.
    const repeat = service();
    clock = at('2026-10-24T23:00:00.000Z'); await repeat.start();
    clock = at('2026-10-25T00:00:05.000Z'); await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    expect(status(repeat)).toEqual({ blocked: 'unconfirmed' });
    // Consent covers exactly the setting it was given: another time in the file is still unconfirmed.
    await repeat.consent('project', 'flow', { ...seoulNine, time: '10:00' });
    await repeat.wake();
    expect(status(repeat)).toEqual({ blocked: 'unconfirmed' });
    // Turned on here: it runs from then on (not the occurrence before it).
    await repeat.consent('project', 'flow', seoulNine);
    await repeat.wake();
    expect(launch).not.toHaveBeenCalled();
    clock = at('2026-10-26T00:00:05.000Z'); await repeat.wake();
    expect(launch).toHaveBeenCalledOnce();
    // Turned off here: the consent goes with it, so the file alone cannot turn it back on.
    await repeat.consent('project', 'flow', { ...seoulNine, enabled: false });
    clock = at('2026-10-27T00:00:05.000Z'); await repeat.wake();
    expect(launch).toHaveBeenCalledOnce();
    expect(status(repeat)?.blocked).toBe('unconfirmed');
  });

  it('keeps a person’s consent and a tick’s claim when they are saved at the same moment', async () => {
    const repeat = await armedAt('2026-10-24T23:00:00.000Z');
    let release!: () => void;
    respond = () => started;
    launch.mockImplementationOnce(async (command) => { receipts.add(command.commandId); await new Promise<void>(resolve => { release = resolve; }); return started; });
    clock = at('2026-10-25T00:00:05.000Z');
    const ticking = repeat.wake();
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    await repeat.consent('other-project', 'flow', seoulNine);
    release(); await ticking;
    await repeat.dispose();
    const saved = JSON.parse(await fs.readFile(path.join(directory, REPEAT_FILE), 'utf8')) as { entries: { projectId: string; consent?: unknown; occurrences: { state: string }[] }[] };
    expect(saved.entries.find(entry => entry.projectId === 'other-project')?.consent).toBeDefined();
    expect(saved.entries.find(entry => entry.projectId === 'project')?.occurrences.at(-1)?.state).toBe('started');
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
      consent: { configDigest: digestOf(seoulNine), at: '2025-12-31T00:00:00.000Z' }, armed: { configDigest: digestOf(seoulNine), armedAt: '2025-12-31T00:00:00.000Z' }, occurrences }] }));
    receipts.add(occurrences[0]!.commandId);
    clock = at('2026-03-12T00:00:05.000Z');
    const repeat = service(); await repeat.start();
    await repeat.dispose();
    const saved = JSON.parse(await fs.readFile(path.join(directory, REPEAT_FILE), 'utf8')) as { entries: [{ occurrences: { key: string; state: string }[] }] };
    expect(saved.entries[0].occurrences).toHaveLength(REPEAT_HISTORY_LIMIT);
    expect(saved.entries[0].occurrences.at(-1)).toMatchObject({ key: '2026-03-12', state: 'started' });
    expect(saved.entries[0].occurrences.some(occurrence => occurrence.key === day(0))).toBe(false); // the old claim settled by its replay, then aged out
  });
});

