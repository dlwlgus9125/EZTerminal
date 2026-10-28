import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { builtinWorkflowTemplates } from '../shared/workflow-templates';
import { WorkflowTemplateStore, installWorkflowTemplateIpc } from './workflow-template-store';

const makeDir = (): string => mkdtempSync(path.join(os.tmpdir(), 'ez-workflow-templates-'));
const graph = builtinWorkflowTemplates()[1].graph;
const routine = { id: 'template-routine', title: '우리 정기 점검', description: '매주 월요일', graph };
const clock = (...times: string[]) => { let index = 0; return () => new Date(times[Math.min(index++, times.length - 1)]); };

describe('WorkflowTemplateStore', () => {
  it('saves, replaces in place keeping when it was first saved, removes, and keeps them across restarts', async () => {
    const dir = makeDir();
    const store = new WorkflowTemplateStore(dir, clock('2026-10-29T01:00:00.000Z', '2026-10-29T02:00:00.000Z', '2026-10-29T03:00:00.000Z'));
    await store.init();
    expect(store.list()).toEqual([]);
    await store.save(routine);
    await store.save({ ...routine, id: 'template-other', title: '다른 것' });
    expect(await store.save({ ...routine, title: '바뀐 이름' })).toMatchObject({ ok: true });
    expect(store.list().map((template) => [template.title, template.createdAt, template.updatedAt])).toEqual([
      ['바뀐 이름', '2026-10-29T01:00:00.000Z', '2026-10-29T03:00:00.000Z'],
      ['다른 것', '2026-10-29T02:00:00.000Z', '2026-10-29T02:00:00.000Z'],
    ]);
    expect(JSON.parse(readFileSync(path.join(dir, 'workflow-templates.json'), 'utf8'))).toMatchObject({ version: 1, templates: [{ id: 'template-routine', graph }, { id: 'template-other' }] });

    const reloaded = new WorkflowTemplateStore(dir);
    await reloaded.init();
    expect(reloaded.list()).toEqual(store.list());
    expect(await reloaded.remove('template-other')).toEqual({ ok: true, templates: [expect.objectContaining({ id: 'template-routine' })] });
  });

  it('refuses incomplete templates, a built-in id, a graph that is not a workflow, and more than 200', async () => {
    const store = new WorkflowTemplateStore(makeDir());
    await store.init();
    expect(await store.save({ ...routine, title: '  ' })).toMatchObject({ ok: false });
    expect(await store.save({ ...routine, id: 'builtin-dev' })).toMatchObject({ ok: false });
    expect(await store.save({ ...routine, graph: { ...graph, nodes: [{ id: 'x' }] } })).toMatchObject({ ok: false });
    expect(await store.save({ ...routine, runs: [] })).toMatchObject({ ok: false });
    for (let index = 0; index < 200; index += 1) await store.save({ ...routine, id: `t${index}` });
    expect(await store.save({ ...routine, id: 'one-more' })).toEqual({ ok: false, error: 'Up to 200 templates can be saved.' });
    expect(store.list()).toHaveLength(200);
    // Replacing one of the 200 still works.
    expect(await store.save({ ...routine, id: 't0', title: '바꿈' })).toMatchObject({ ok: true });
  });

  it('starts empty from a damaged file instead of failing', async () => {
    const dir = makeDir();
    writeFileSync(path.join(dir, 'workflow-templates.json'), '{"version":1,"templates":[{"id":1}]}');
    const store = new WorkflowTemplateStore(dir);
    await store.init();
    expect(store.list()).toEqual([]);
    expect(await store.save(routine)).toMatchObject({ ok: true });
  });

  it('answers the renderer after the store is ready and removes its handlers', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = { handle: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => { handlers.set(name, handler); }), removeHandler: vi.fn((name: string) => { handlers.delete(name); }) };
    const store = new WorkflowTemplateStore(makeDir());
    const dispose = installWorkflowTemplateIpc({ ipc: ipc as never, store, ready: store.init() });
    expect(await handlers.get('workflow-templates:save')!({}, routine)).toMatchObject({ ok: true });
    expect(await handlers.get('workflow-templates:list')!({})).toEqual([expect.objectContaining(routine)]);
    expect(await handlers.get('workflow-templates:remove')!({}, 'template-routine')).toEqual({ ok: true, templates: [] });
    expect(await handlers.get('workflow-templates:remove')!({}, 7)).toMatchObject({ ok: false });
    dispose();
    expect(handlers.size).toBe(0);
  });
});
