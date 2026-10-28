import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PlanningMutationResultSchema,
  PlanningReadResultSchema,
  type PlanningCommand,
  type PlanningDraft,
  type PlanningItem,
  type TaskDefinition,
} from '../shared/planning';
import { seedPlanning, type SeedBaseline, type SeedDraft } from './planning-seed.fixture';
import { PlanningService } from './planning-service';

let root: string;
let service: PlanningService;
const actor = { kind: 'user', id: 'desktop' } as const;
const now = () => new Date('2026-10-13T04:00:00.000Z');
const filePath = () => path.join(root, '.ezterminal', 'planning', 'project.json');
const createService = () => new PlanningService({ resolveProjectRoot: (id) => id === 'project-1' ? root : null, now });
const EMPTY: PlanningDraft = { id: 'draft-1', items: [], links: [], scenes: [], components: [], profiles: [], tasks: [], assets: [] };
const item = (id = 'requirement-1', overrides: Partial<PlanningItem> = {}): PlanningItem => ({
  id, revision: 0, title: 'Preserve terminal sessions', kind: 'requirement', body: 'Use the existing PTY authority.',
  status: 'ready', acceptance: ['Switching chat skin preserves the terminal.'], ...overrides,
});
const task = (id: string, overrides: Partial<TaskDefinition> = {}): TaskDefinition => ({
  id, revision: 0, title: id, objective: 'Implement the reviewed design.', featureIds: [], screenIds: [],
  inputRefs: [], interfaceRefs: [], dependencyIds: [], allowedPaths: ['src'],
  acceptance: [{ id: `${id}-acceptance`, description: 'The required behavior works.' }],
  validationPlan: [{ id: `${id}-check`, acceptanceIds: [`${id}-acceptance`], method: 'command', command: 'pnpm test', description: 'Run checks', environment: 'Windows' }],
  status: 'ready', ...overrides,
});
const edits: PlanningCommand[] = [
  { commandId: 'edit', projectId: 'project-1', expectedRevision: 1, actor, type: 'planning.patch', payload: { summary: 'Edit', operations: [{ op: 'item.put', value: item('new') }] } },
  { commandId: 'freeze', projectId: 'project-1', expectedRevision: 1, actor, type: 'planning.freeze', payload: { baselineId: 'frozen', title: 'Frozen' } },
  { commandId: 'quick', projectId: 'project-1', expectedRevision: 1, actor, type: 'planning.quick-freeze', payload: { baselineId: 'quick', title: 'Quick', task: task('quick'), profileIds: [] } },
];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-planning-'));
  service = createService();
});
afterEach(async () => {
  await service.flush();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('PlanningService durable project authority', () => {
  it('reads a legacy project without creating planning files or touching terminal data', async () => {
    await fs.writeFile(path.join(root, 'terminal-state'), 'existing');
    const result = await service.read('project-1');
    expect(PlanningReadResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ ok: true, snapshot: { revision: 0, draft: { items: [] } } });
    expect(await fs.readdir(root)).toEqual(['terminal-state']);
    expect(await service.read('unknown')).toMatchObject({ ok: false, error: 'not-found' });
  });

  it('refuses every planning edit (the planning screen is gone) and leaves the file as it was', async () => {
    await seedPlanning(service, 'project-1', { items: [item()] });
    const before = await fs.readFile(filePath(), 'utf8');
    for (const command of edits) {
      const result = await service.execute(command);
      expect(PlanningMutationResultSchema.safeParse(result).success).toBe(true);
      expect(result).toMatchObject({ ok: false, error: 'unavailable', message: expect.stringContaining('Update the app') });
    }
    expect(await service.execute({ ...edits[0], expectedRevision: -1 })).toMatchObject({ ok: false, error: 'invalid' });
    expect(await fs.readFile(filePath(), 'utf8')).toBe(before);
    expect(await createService().read('project-1')).toMatchObject({ ok: true, snapshot: { revision: 1, history: [] } });
  });

  it('restores into a new project only, and checks every baseline against its draft', async () => {
    const seeded = await seedPlanning(service, 'project-1', { items: [item()] }, { baselines: [{ id: 'base', title: 'Base' }] });
    expect(await service.importSnapshot('project-1', seeded)).toMatchObject({ ok: false, error: 'conflict' });
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-planning-restore-'));
    try {
      const restore = new PlanningService({ resolveProjectRoot: (id) => id === 'project-2' ? other : null, now });
      const broken = structuredClone(seeded);
      broken.baselines[0]!.draft.items[0]!.body = 'Changed baseline';
      expect(await restore.importSnapshot('project-2', broken)).toMatchObject({ ok: false, error: 'invalid' });
      expect(await restore.importSnapshot('project-2', seeded)).toMatchObject({ ok: true, snapshot: { projectId: 'project-2', baselines: [{ id: 'base' }] } });
    } finally { await fs.rm(other, { recursive: true, force: true }); }
  });

  it('rejects tampered baseline data and preserves the original bytes for recovery', async () => {
    await seedPlanning(service, 'project-1', { items: [item()] }, { baselines: [{ id: 'base', title: 'Base' }] });
    const stored = JSON.parse(await fs.readFile(filePath(), 'utf8'));
    stored.snapshot.baselines[0].draft.items[0].body = 'Changed baseline';
    const tampered = JSON.stringify(stored);
    await fs.writeFile(filePath(), tampered);
    expect(await createService().read('project-1')).toMatchObject({ ok: false, error: 'corrupt' });
    expect(await fs.readFile(filePath(), 'utf8')).toBe(tampered);
  });

  it('preserves malformed or externally edited files instead of quarantining or replacing them', async () => {
    await seedPlanning(service, 'project-1', { items: [item()] });
    const original = await fs.readFile(filePath(), 'utf8');
    const malformed = '{ broken but recoverable';
    await fs.writeFile(filePath(), malformed);
    expect(await service.read('project-1')).toMatchObject({ ok: false, error: 'corrupt' });
    expect(await service.captureWorkflowBaseline('project-1', 'legacy-default', 'run', 'Run', EMPTY)).toMatchObject({ ok: false, error: 'corrupt' });
    expect(await fs.readFile(filePath(), 'utf8')).toBe(malformed);
    await fs.writeFile(filePath(), original);
    // Another host instance writes the file (a legacy-default flow run's baseline).
    expect((await createService().captureWorkflowBaseline('project-1', 'legacy-default', 'outside', 'Outside', EMPTY)).ok).toBe(true);
    expect(await service.read('project-1')).toMatchObject({ ok: false, error: 'external-change', message: expect.stringContaining('restart the application') });
    expect(await service.read('project-1')).toMatchObject({ ok: false, error: 'external-change' });
    expect(await createService().read('project-1')).toMatchObject({ ok: true, snapshot: { revision: 2 } });
  });

  it('blocks planning directory junctions that escape the authorized project', async () => {
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-planning-external-'));
    try {
      await fs.mkdir(path.join(root, '.ezterminal'));
      await fs.symlink(external, path.join(root, '.ezterminal', 'planning'), process.platform === 'win32' ? 'junction' : 'dir');
      expect(await service.read('project-1')).toMatchObject({ ok: false, error: 'forbidden' });
      expect(await service.captureWorkflowBaseline('project-1', 'legacy-default', 'run', 'Run', EMPTY)).toMatchObject({ ok: false, error: 'forbidden' });
      expect(await fs.readdir(external)).toEqual([]);
    } finally { await fs.rm(external, { recursive: true, force: true }); }
  });
});

describe('PlanningService 기획 기준본 정리 (I2-7f)', () => {
  const A = `workflow-${'a'.repeat(32)}`;
  const B = `workflow-${'b'.repeat(32)}`;
  const RUNTIME = { kind: 'user', id: 'workflow-runtime' } as const;
  const scoped = () => new PlanningService({ resolveProjectRoot: (id) => id === 'project-1' ? root : null, now, subprojectId: 'flow-1' });
  /** Two workflow-run baselines captured the way a run does, each with a ready item. */
  async function captured(planning: PlanningService) {
    const read = await planning.read('project-1', 'flow-1'); if (!read.ok) throw new Error(read.message);
    const draft = { ...read.snapshot.draft, items: [item('requirement-1')] };
    const first = await planning.captureWorkflowBaseline('project-1', 'flow-1', A, 'Run 1', draft);
    const second = await planning.captureWorkflowBaseline('project-1', 'flow-1', B, 'Run 2', draft);
    if (!first.ok || !second.ok) throw new Error('capture failed');
    const snapshot = second.snapshot;
    return { snapshot, hash: (id: string) => snapshot.baselines.find(entry => entry.id === id)!.hash };
  }
  /** A flow's planning file as it can still be found: run baselines A and B beside what a person left. */
  async function seededFlow(planning: PlanningService, subprojectId: string, draft: SeedDraft, others: readonly SeedBaseline[] = []) {
    const runs = { items: [item('requirement-1')] };
    const snapshot = await seedPlanning(planning, 'project-1', draft, { subprojectId, keepRevisions: true, baselines: [
      { id: A, title: 'Run 1', draft: runs, createdBy: RUNTIME }, { id: B, title: 'Run 2', draft: runs, createdBy: RUNTIME }, ...others,
    ] });
    return (id: string) => snapshot.baselines.find(entry => entry.id === id)!.hash;
  }

  it('removes a baseline this host made for a run, keeps the rest and the file valid', async () => {
    const planning = scoped();
    const { snapshot, hash } = await captured(planning);
    const result = await planning.pruneWorkflowBaselines('project-1', 'flow-1', [{ id: A, hash: hash(A) }], []);
    expect(result).toEqual({ ok: true, removed: [A] });
    const after = await createService().read('project-1', 'flow-1');
    if (!after.ok) throw new Error(after.message);
    expect(after.snapshot.baselines.map(entry => entry.id)).toEqual([B]);
    expect(after.snapshot.revision).toBe(snapshot.revision + 1);
    expect(after.snapshot.draft).toEqual(snapshot.draft);
    await planning.flush();
  });

  it('removes nothing it cannot prove is a run’s own: another hash, another run’s, the root file', async () => {
    const planning = scoped();
    const { hash } = await captured(planning);
    expect(await planning.pruneWorkflowBaselines('project-1', 'flow-1', [{ id: A, hash: '0'.repeat(64) }], [])).toEqual({ ok: true, removed: [] });
    // A dry run answers what would go and writes nothing.
    expect(await planning.pruneWorkflowBaselines('project-1', 'flow-1', [{ id: A, hash: hash(A) }], [], { dryRun: true })).toEqual({ ok: true, removed: [A] });
    const still = await planning.read('project-1', 'flow-1'); if (!still.ok) throw new Error(still.message);
    expect(still.snapshot.baselines.some(entry => entry.id === A)).toBe(true);
    expect(await planning.pruneWorkflowBaselines('project-1', 'flow-1', [{ id: A, hash: hash(A) }], [A])).toEqual({ ok: true, removed: [] });
    expect(await planning.pruneWorkflowBaselines('project-1', 'legacy-default', [{ id: A, hash: hash(A) }], [])).toEqual({ ok: true, removed: [] });
    await planning.flush();
  });

  it('never removes a person’s baseline named like a run’s', async () => {
    const planning = scoped();
    const mine = `workflow-${'c'.repeat(32)}`;
    const hash = await seededFlow(planning, 'flow-1', { items: [item('requirement-1')] }, [{ id: mine, title: 'Mine', purpose: 'quick-task', draft: { tasks: [task('mine')] } }]);
    expect(await planning.pruneWorkflowBaselines('project-1', 'flow-1', [{ id: mine, hash: hash(mine) }], [])).toEqual({ ok: true, removed: [] });
    await planning.flush();
  });

  it('keeps a baseline the draft or a kept baseline refers to, following the chain', async () => {
    const planning = scoped();
    const refersTo = (baselineId: string) => task('uses-run-1', { inputRefs: [{ id: 'requirement-1', kind: 'item', revision: 0, baselineId }] });
    // The draft refers to A: it stays.
    const draftHash = await seededFlow(planning, 'flow-1', { items: [item('requirement-1')], tasks: [refersTo(A)] });
    expect(await planning.pruneWorkflowBaselines('project-1', 'flow-1', [{ id: A, hash: draftHash(A) }], [])).toEqual({ ok: true, removed: [] });
    // A person's baseline frozen from such a draft refers to A, the draft no longer does: A still stays, through it.
    const chainHash = await seededFlow(planning, 'flow-2', { items: [item('requirement-1')] },
      [{ id: 'person-baseline', title: 'Mine', draft: { items: [item('requirement-1')], tasks: [refersTo(A)] } }]);
    expect(await planning.pruneWorkflowBaselines('project-1', 'flow-2', [{ id: A, hash: chainHash(A) }], [])).toEqual({ ok: true, removed: [] });
    // B nothing refers to: it goes.
    expect(await planning.pruneWorkflowBaselines('project-1', 'flow-2', [{ id: B, hash: chainHash(B) }], [])).toEqual({ ok: true, removed: [B] });
    await planning.flush();
  });

  it('keeps a baseline only a kept baseline refers to (no draft or history in between)', async () => {
    const planning = scoped();
    const { snapshot, hash } = await captured(planning);
    const C = `workflow-${'d'.repeat(32)}`;
    const referring = { ...snapshot.draft, items: [item('requirement-1')], tasks: [task('uses-run-1', { inputRefs: [{ id: 'requirement-1', kind: 'item', revision: 0, baselineId: A }] })] };
    const kept = await planning.captureWorkflowBaseline('project-1', 'flow-1', C, 'Run 3', referring);
    if (!kept.ok) throw new Error(kept.message);
    expect(await planning.pruneWorkflowBaselines('project-1', 'flow-1', [{ id: A, hash: hash(A) }], [C])).toEqual({ ok: true, removed: [] });
    await planning.flush();
  });
});
