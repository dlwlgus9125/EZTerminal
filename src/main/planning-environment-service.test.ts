import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanningEnvironmentService } from './planning-environment-service';

const owned: { directory: string; service: PlanningEnvironmentService }[] = [];
afterEach(async () => {
  for (const entry of owned.splice(0)) { await entry.service.dispose(); await fs.rm(entry.directory, { recursive: true, force: true }); }
});
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezt-execution-env-'));
  const service = new PlanningEnvironmentService(directory);
  owned.push({ directory, service });
  await service.init();
  const reserve = (id: string, mode: 'serial' | 'namespaced' = 'serial') => service.reserve({
    runId: 'run', taskId: id, attemptId: id, sessionId: id, workspaceId: id, workspaceRoot: directory,
  }, 1, mode);
  return { directory, service, reserve };
}
describe('planning execution environments', () => {
  it('reserves distinct ports/namespaces and serializes shared resources while allowing explicit namespaces', async () => {
    const f = await fixture();
    const a = await f.reserve('a', 'namespaced'); const b = await f.reserve('b', 'namespaced');
    expect(a.ports[0]).not.toBe(b.ports[0]);
    expect(a.environment.TMP).not.toBe(b.environment.TMP);
    expect(a.environment.EZTERMINAL_TEST_NAMESPACE).not.toBe(b.environment.EZTERMINAL_TEST_NAMESPACE);
    await f.service.activate('a');
    expect(f.service.canActivate('b')).toBe(true);
    await f.reserve('serial');
    expect(f.service.canActivate('serial')).toBe(false);
    await expect(f.service.activate('serial')).rejects.toThrow(/occupied/u);
    await f.service.release('a');
    await f.service.activate('serial');
    expect(f.service.canActivate('b')).toBe(false);
  });
  it('waits for confirmed worker release before validation and cancels a pending validation without running it', async () => {
    const f = await fixture();
    await f.reserve('a'); await f.service.activate('a');
    const check = vi.fn(async () => 'checked');
    const abort = new AbortController();
    const cancelled = f.service.runValidation(check, abort.signal);
    const rejection = expect(cancelled).rejects.toThrow('stopping');
    abort.abort(new Error('stopping'));
    await rejection;
    expect(check).not.toHaveBeenCalled();
    const waiting = f.service.runValidation(check);
    expect(check).not.toHaveBeenCalled();
    await f.service.release('a');
    expect(await waiting).toBe('checked');
    expect(check).toHaveBeenCalledOnce();
  });
  it('preserves outputs and marks active leases orphaned after restart without killing or deleting anything', async () => {
    const f = await fixture();
    const lease = await f.reserve('a');
    await fs.writeFile(path.join(lease.environment.EZTERMINAL_OUTPUT_DIR, 'evidence.txt'), 'preserved');
    await f.service.activate('a');
    const recovered = new PlanningEnvironmentService(f.directory);
    await recovered.init();
    expect(recovered.read('a')?.status).toBe('orphaned');
    await recovered.release('a');
    expect(await fs.readFile(path.join(lease.environment.EZTERMINAL_OUTPUT_DIR, 'evidence.txt'), 'utf8')).toBe('preserved');
    await recovered.dispose();
  });
});
