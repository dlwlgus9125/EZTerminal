import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProjectArchiveRequestSchema, type ProjectArchiveResult } from '../shared/project-archive';
import type { LocalMutationIngress } from './local-mutation-ingress';
import type { ProjectArchiveService } from './project-archive-service';

/** Authenticated Android commands share host ownership; uploaded paths are confined to project inboxes. */
export class ProjectArchiveRemoteAuthority {
  constructor(private readonly options: { service: ProjectArchiveService; ready: Promise<unknown>; ingress: LocalMutationIngress; userDataDir: string;
    available: (principalId: string) => boolean }) {}
  async execute(value: unknown, principalId: string): Promise<ProjectArchiveResult> {
    const forbidden: ProjectArchiveResult = { ok: false, error: 'forbidden', message: 'An authenticated connected device is required.' };
    if (!this.options.available(principalId)) return forbidden;
    const parsed = ProjectArchiveRequestSchema.safeParse(value);
    if (!parsed.success) return { ok: false, error: 'invalid-request', message: 'The archive request is invalid.' };
    try {
      return await this.options.ingress.run(async signal => {
        await this.options.ready; signal.throwIfAborted(); if (!this.options.available(principalId)) return forbidden;
        const request = parsed.data; const service = this.options.service;
        if (request.type === 'inventory') return { ok: true, kind: 'inventory', inventory: await service.inventory(request.projectId) };
        if (request.type === 'history') return { ok: true, kind: 'history', history: await service.history(request.projectId) };
        if (request.type === 'prepare-import') return { ok: true, kind: 'prepare-import', directoryPath: await service.prepareImport(request.projectId) };
        if (request.type === 'inspect') {
          if (!request.projectId || !request.uploadedPath) return { ok: false, error: 'invalid-request', message: 'Upload and select an archive from the owning project inbox first.' };
          return { ok: true, kind: 'inspect', ...await service.inspectUploaded(request.projectId, request.uploadedPath) };
        }
        if (request.type === 'export') {
          const destination = await service.remoteExportPath(request.projectId, request.commandId);
          return { ok: true, kind: 'export', path: destination, manifest: await service.exportProject(request.projectId, destination, request.commandId) };
        }
        if (request.type === 'restore') {
          const parent = path.join(this.options.userDataDir, 'restored-projects'); await fs.mkdir(parent, { recursive: true });
          if ((await fs.lstat(parent)).isSymbolicLink()) throw new Error('The host restore directory is not an owned ordinary directory.');
          signal.throwIfAborted(); if (!this.options.available(principalId)) return forbidden;
          return { ok: true, kind: 'restore', ...await service.restoreArchive(request.archiveId, request.name, parent, request.commandId) };
        }
        return { ok: true, kind: 'cleanup', removedItems: await service.cleanup(request.projectId, request.inventoryToken, request.sessionIds) };
      });
    } catch (error) { return { ok: false, error: 'unavailable', message: error instanceof Error ? error.message : 'Archive operation failed; original records were preserved.' }; }
  }
}
