import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { LocalMutationIngress } from './local-mutation-ingress';
import type { FeatureIpc } from './ipc-registration';
import { installProjectArchiveIpc } from './project-archive-ipc';
import { ProjectArchiveRemoteAuthority } from './project-archive-remote-authority';
import type { ProjectArchiveService } from './project-archive-service';

function fixture(ready = Promise.resolve<unknown>(undefined)) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = { handle: vi.fn((name, handler) => handlers.set(name, handler)), removeHandler: vi.fn(name => handlers.delete(name)), on: vi.fn(), removeListener: vi.fn() } as FeatureIpc;
  const service = { inventory: vi.fn(async () => ({ projectId: 'P', token: 'a'.repeat(64), revision: 0, groups: [], conversations: [] })),
    exportProject: vi.fn(), remoteExportPath: vi.fn(async () => 'owned-backup'), inspectUploaded: vi.fn(), inspectArchive: vi.fn(), restoreArchive: vi.fn(), history: vi.fn(), cleanup: vi.fn(), prepareImport: vi.fn() };
  const principal = vi.fn((_event: IpcMainInvokeEvent, id: unknown) => id === 'known' ? 'desktop-user' : null);
  const ingress = new LocalMutationIngress('archive-test');
  const chooseExportPath = vi.fn(async () => 'user-selected-file'); const confirmCleanup = vi.fn(async () => true);
  const dispose = installProjectArchiveIpc({ ipc, service: service as unknown as ProjectArchiveService, ready, ingress, resolvePrincipal: principal,
    chooseExportPath, chooseArchivePath: vi.fn(async () => null), chooseRestoreParent: vi.fn(async () => null), confirmCleanup });
  const invoke = (request: unknown, id = 'known') => handlers.get('project-archive:execute')!({}, id, request);
  return { service, principal, ingress, chooseExportPath, confirmCleanup, dispose, handlers, invoke };
}

describe('project archive IPC admission', () => {
  it('authenticates before file dialogs and unregisters its handler', async () => {
    const f = fixture();
    expect(await f.invoke({ type: 'export', projectId: 'P', commandId: 'C' }, 'spoofed')).toMatchObject({ ok: false, error: 'forbidden' });
    expect(f.chooseExportPath).not.toHaveBeenCalled(); expect(f.service.exportProject).not.toHaveBeenCalled();
    f.dispose(); expect(f.handlers.size).toBe(0);
  });
  it('rechecks authority after a native destination dialog and denies writes during shutdown', async () => {
    const f = fixture();
    f.chooseExportPath.mockImplementation(async () => { f.principal.mockReturnValue(null); return 'destination'; });
    expect(await f.invoke({ type: 'export', projectId: 'P', commandId: 'C' })).toMatchObject({ ok: false, error: 'forbidden' });
    expect(f.service.exportProject).not.toHaveBeenCalled();
    const closing = fixture(); await closing.ingress.closeAndDrain();
    expect(await closing.invoke({ type: 'export', projectId: 'P', commandId: 'C' })).toMatchObject({ ok: false, error: 'unavailable' });
    expect(closing.chooseExportPath).not.toHaveBeenCalled();
  });
  it('does not delete after an outdated preview or cancelled native confirmation', async () => {
    const f = fixture();
    expect(await f.invoke({ type: 'cleanup', projectId: 'P', inventoryToken: 'b'.repeat(64), sessionIds: ['S'], confirmation: 'delete-selected-archived-history' })).toMatchObject({ ok: false, error: 'invalid-request' });
    f.confirmCleanup.mockResolvedValue(false);
    expect(await f.invoke({ type: 'cleanup', projectId: 'P', inventoryToken: 'a'.repeat(64), sessionIds: ['S'], confirmation: 'delete-selected-archived-history' })).toMatchObject({ ok: false, error: 'cancelled' });
    expect(f.service.cleanup).not.toHaveBeenCalled();
  });
  it('requires an authenticated remote caller and project-owned upload selection', async () => {
    const f = fixture(); const available = vi.fn(() => false);
    const authority = new ProjectArchiveRemoteAuthority({ service: f.service as unknown as ProjectArchiveService, available, ingress: f.ingress, ready: Promise.resolve(), userDataDir: '/owned' });
    expect(await authority.execute({ type: 'inventory', projectId: 'P' }, 'device')).toMatchObject({ ok: false, error: 'forbidden' });
    available.mockReturnValue(true);
    expect(await authority.execute({ type: 'inspect', uploadedPath: 'arbitrary' }, 'device')).toMatchObject({ ok: false, error: 'invalid-request' });
    expect(f.service.inspectArchive).not.toHaveBeenCalled(); expect(f.service.inspectUploaded).not.toHaveBeenCalled();
    await authority.execute({ type: 'export', projectId: 'P', commandId: 'C' }, 'device');
    expect(f.service.remoteExportPath).toHaveBeenCalledWith('P', 'C');
    expect(f.service.exportProject).toHaveBeenCalledWith('P', 'owned-backup', 'C');
  });
});
