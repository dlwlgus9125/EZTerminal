import { ProjectArchiveRequestSchema, type ProjectArchiveRequest } from '../shared/project-archive';

/**
 * A backup, restore or cleanup request whose answer was not seen (the app closed, the link dropped).
 * The archive dialog shows it until the person checks it again, so the same request is never sent
 * twice blindly. One per project; `scope` keeps one host's request apart from another's (the phone
 * passes its PC). Kept in this device's storage; an unreadable entry is dropped.
 */
const KEY = 'ezterminal-project-archive-pending-v1';

function keyOf(scope: string, projectId: string): string {
  return `${KEY}:${scope}:${projectId}`;
}

export interface ProjectArchivePendingStore {
  read(projectId: string): ProjectArchiveRequest | null;
  write(projectId: string, request: ProjectArchiveRequest | null): Promise<void>;
}

export function projectArchivePendingStore(scope: string, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = window.localStorage): ProjectArchivePendingStore {
  return {
    read(projectId) {
      const raw = storage.getItem(keyOf(scope, projectId));
      if (!raw) return null;
      try {
        const parsed = ProjectArchiveRequestSchema.safeParse(JSON.parse(raw));
        if (parsed.success && (!('projectId' in parsed.data) || parsed.data.projectId === undefined || parsed.data.projectId === projectId)) return parsed.data;
      } catch {
        // Unreadable: dropped below.
      }
      storage.removeItem(keyOf(scope, projectId));
      return null;
    },
    async write(projectId, request) {
      if (request) storage.setItem(keyOf(scope, projectId), JSON.stringify(request));
      else storage.removeItem(keyOf(scope, projectId));
    },
  };
}
