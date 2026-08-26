import type {
  ProjectMapApproval,
  ProjectMapCollectionRequest,
} from '../shared/project-map';
import { JsonFile } from './json-file';

const SCHEMA_VERSION = 1 as const;
const MAX_APPROVALS = 256;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/u;
const PORTABLE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/u;

interface ApprovalEntry extends ProjectMapApproval {
  readonly key: string;
}

interface ApprovalFile {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly entries: readonly ApprovalEntry[];
}

const EMPTY: ApprovalFile = { schemaVersion: SCHEMA_VERSION, entries: [] };

function requestKey(request: ProjectMapCollectionRequest, mapId: string): string {
  return `${request.projectId}\u0000${request.ownerRootId}\u0000${request.ownerWorkspaceId}\u0000${mapId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validOpaque(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 768
    && ![...value].some((character) => (character.codePointAt(0) ?? 0) < 0x20);
}

function validKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 768
    && value.split('\u0000').length === 4
    && value.split('\u0000').every((part) => validOpaque(part));
}

function validateFile(value: unknown): ApprovalFile | null {
  if (!isRecord(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || !Array.isArray(value.entries)
    || value.entries.length > MAX_APPROVALS
    || Object.keys(value).some((key) => key !== 'schemaVersion' && key !== 'entries')) return null;
  const entries: ApprovalEntry[] = [];
  const keys = new Set<string>();
  for (const candidate of value.entries) {
    if (!isRecord(candidate)
      || Object.keys(candidate).length !== 4
      || !validKey(candidate.key)
      || keys.has(candidate.key)
      || typeof candidate.mapId !== 'string'
      || !PORTABLE_ID_RE.test(candidate.mapId)
      || typeof candidate.fingerprint !== 'string'
      || !SHA256_RE.test(candidate.fingerprint)
      || typeof candidate.approvedAt !== 'string'
      || !Number.isFinite(Date.parse(candidate.approvedAt))) return null;
    keys.add(candidate.key);
    entries.push({
      key: candidate.key,
      mapId: candidate.mapId,
      fingerprint: candidate.fingerprint,
      approvedAt: candidate.approvedAt,
    });
  }
  return { schemaVersion: SCHEMA_VERSION, entries };
}

export class ProjectMapApprovalStore {
  private readonly file: JsonFile;
  private snapshot: ApprovalFile = EMPTY;

  constructor(userDataDir: string) {
    this.file = new JsonFile(userDataDir, 'project-map-approvals.json');
  }

  async init(): Promise<void> {
    await this.file.init();
    this.snapshot = await this.file.readValidated(validateFile, EMPTY);
  }

  get(request: ProjectMapCollectionRequest, mapId: string): ProjectMapApproval | undefined {
    const entry = this.snapshot.entries.find((candidate) => candidate.key === requestKey(request, mapId));
    return entry ? { mapId: entry.mapId, fingerprint: entry.fingerprint, approvedAt: entry.approvedAt } : undefined;
  }

  async approve(
    request: ProjectMapCollectionRequest,
    mapId: string,
    fingerprint: string,
  ): Promise<ProjectMapApproval> {
    if (!PORTABLE_ID_RE.test(mapId) || !SHA256_RE.test(fingerprint)) {
      throw new Error('Invalid Project Map approval identity.');
    }
    const approval: ProjectMapApproval = { mapId, fingerprint, approvedAt: new Date().toISOString() };
    const key = requestKey(request, mapId);
    const updated = await this.file.update(
      validateFile,
      EMPTY,
      (current) => ({
        schemaVersion: SCHEMA_VERSION,
        entries: [
          ...current.entries.filter((entry) => entry.key !== key),
          { key, ...approval },
        ].slice(-MAX_APPROVALS),
      }),
      'approve project map',
    );
    if (!updated) throw new Error('Could not persist Project Map approval.');
    this.snapshot = updated;
    return approval;
  }

  flush(): Promise<void> {
    return this.file.flush();
  }
}
