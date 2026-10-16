import { describe, expect, it, vi } from 'vitest';
import type { ProjectArchiveResult } from '../../src/shared/project-archive';
import { mobileProjectArchiveAccess } from './mobile-project-archive';

describe('Android project archive transfers', () => {
  it('uploads the selected file to the host-owned inbox before inspecting the actual final filename', async () => {
    const executeProjectArchive = vi.fn(async (request): Promise<ProjectArchiveResult> => request.type === 'prepare-import'
      ? { ok: true, kind: 'prepare-import', directoryPath: 'C:/Project/.ezterminal/archive-inbox' }
      : { ok: false, error: 'unavailable', message: 'fixture parse result' });
    const uploadFile = vi.fn(async () => ({ finalName: 'backup-2.json' })); const downloadFile = vi.fn();
    const file = new File(['{}'], 'backup.json', { type: 'application/json' });
    const access = mobileProjectArchiveAccess({ executeProjectArchive, uploadFile, downloadFile }, { chooseFile: async () => file });
    await access.executeProjectArchive({ type: 'inspect', projectId: 'P' });
    expect(uploadFile).toHaveBeenCalledWith('C:/Project/.ezterminal/archive-inbox', 'backup.json', new Uint8Array([123, 125]), expect.any(Function));
    expect(executeProjectArchive).toHaveBeenLastCalledWith({ type: 'inspect', projectId: 'P', uploadedPath: 'C:/Project/.ezterminal/archive-inbox/backup-2.json' });
  });
  it('preserves the same export command through a native storage failure and only retries on request', async () => {
    const executeProjectArchive = vi.fn(async () => ({ ok: true, kind: 'export', path: 'owned/backup.json', manifest: {} }) as ProjectArchiveResult);
    const downloadFile = vi.fn(async () => ({ name: 'backup.json', bytes: new Uint8Array([1, 2]) })); const uploadFile = vi.fn();
    const saveFile = vi.fn().mockRejectedValueOnce(new Error('Storage full')).mockResolvedValueOnce({ name: 'backup.json', uri: 'content://downloads/one' });
    const access = mobileProjectArchiveAccess({ executeProjectArchive, downloadFile, uploadFile }, { saveFile });
    const request = { type: 'export' as const, projectId: 'P', commandId: 'exact-export-command' };
    expect(await access.executeProjectArchive(request)).toMatchObject({ ok: false, message: 'Storage full' });
    expect(executeProjectArchive).toHaveBeenCalledOnce();
    expect(await access.executeProjectArchive(request)).toMatchObject({ ok: true, kind: 'export', path: 'content://downloads/one' });
    expect(executeProjectArchive).toHaveBeenNthCalledWith(1, request);
    expect(executeProjectArchive).toHaveBeenNthCalledWith(2, request);
  });
  it('does not contact the PC after the Android picker is cancelled', async () => {
    const executeProjectArchive = vi.fn(); const uploadFile = vi.fn(); const downloadFile = vi.fn();
    const access = mobileProjectArchiveAccess({ executeProjectArchive, uploadFile, downloadFile }, { chooseFile: async () => null });
    expect(await access.executeProjectArchive({ type: 'inspect', projectId: 'P' })).toMatchObject({ ok: false, error: 'cancelled' });
    expect(executeProjectArchive).not.toHaveBeenCalled();
  });
});
