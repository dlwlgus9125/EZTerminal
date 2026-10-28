import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanningService } from './planning-service';
import { PlanningAuthority } from './planning-authority';
import { LocalMutationIngress } from './local-mutation-ingress';
import type { PlanningCommand } from '../shared/planning';
import { isDispatchableClientMessage } from './remote-message-validation';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-planning-authority-'));
  roots.push(root);
  const service = new PlanningService({ resolveProjectRoot: (id) => id === 'project' ? root : null });
  const ingress = new LocalMutationIngress('planning-test');
  const available = vi.fn(() => true);
  return { service, ingress, available, authority: new PlanningAuthority({ service, ingress, available, ready: Promise.resolve() }) };
}
function command(): PlanningCommand {
  return {
    commandId: 'change-1', projectId: 'project', expectedRevision: 0,
    actor: { kind: 'ai', id: 'spoofed' }, type: 'planning.patch',
    payload: { summary: 'New requirement', operations: [{ op: 'item.put', value: {
      id: 'requirement-1', revision: 0, title: 'Preserve sessions', kind: 'requirement',
      body: 'Skin changes preserve the running session.', status: 'draft', acceptance: [],
    } }] },
  };
}

describe('transport-independent planning authority', () => {
  it('replaces caller identity and hands an older phone edit to the store, which refuses it and changes nothing', async () => {
    // I5: planning edits belonged to the removed planning screen; only an older phone still sends them.
    const { service, ingress, available } = await fixture();
    const execute = vi.spyOn(service, 'execute');
    const authority = new PlanningAuthority({ service, ingress, available, ready: Promise.resolve() });
    expect(await authority.execute(command(), 'android:device-1')).toMatchObject({ ok: false, error: 'forbidden' });
    expect(execute.mock.calls[0]![0]).toMatchObject({ actor: { kind: 'user', id: 'android:device-1' } });
    expect(await authority.read('project')).toMatchObject({ ok: true, snapshot: { revision: 0, history: [] } });
  });

  it('does not mutate after shutdown admission closes or authority becomes unavailable', async () => {
    const { authority, ingress, available } = await fixture();
    available.mockReturnValue(false);
    expect(await authority.execute(command(), 'desktop')).toMatchObject({ ok: false, error: 'unavailable' });
    available.mockReturnValue(true);
    await ingress.closeAndDrain();
    expect(await authority.execute(command(), 'desktop')).toMatchObject({ ok: false, error: 'unavailable' });
    expect(await authority.read('project')).toMatchObject({ ok: true, snapshot: { revision: 0 } });
  });

  it('waits for already-admitted persistence before shutdown resolves', async () => {
    const { service, ingress, available } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async (input: PlanningCommand) => { await gate; return service.execute(input); });
    const authority = new PlanningAuthority({ service: { read: (id) => service.read(id), execute }, ingress, available, ready: Promise.resolve() });
    const pending = authority.execute(command(), 'desktop');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    let drained = false;
    const drain = ingress.closeAndDrain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    expect(await pending).toMatchObject({ ok: false, error: 'forbidden' });
    await drain;
    expect(drained).toBe(true);
  });

  it('rejects malformed wire commands and never accepts arbitrary filesystem roots', async () => {
    const { authority } = await fixture();
    expect(isDispatchableClientMessage({ kind: 'planning-read', requestId: 'r1', projectId: '../other' })).toBe(false);
    expect(isDispatchableClientMessage({ kind: 'planning-execute', requestId: 'r1', command: { ...command(), rootPath: 'C:/' } })).toBe(false);
    expect(await authority.read('../other')).toMatchObject({ ok: false, error: 'invalid' });
    expect(await authority.execute({ ...command(), expectedRevision: -1 }, 'desktop')).toMatchObject({ ok: false, error: 'invalid' });
    expect(await authority.read('unknown-project')).toMatchObject({ ok: false, error: 'not-found' });
  });
});
