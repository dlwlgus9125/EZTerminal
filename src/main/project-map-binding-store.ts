import {
  MAX_PROJECT_MAP_ROOTS,
  type ProjectMapCollectionRequest,
  type ProjectMapRootBinding,
} from '../shared/project-map';
import { JsonFile } from './json-file';

const SCHEMA_VERSION = 1 as const;

interface BindingEntry {
  readonly key: string;
  readonly bindings: readonly ProjectMapRootBinding[];
  readonly updatedAt: string;
}

interface BindingFile {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly entries: readonly BindingEntry[];
}

const EMPTY: BindingFile = { schemaVersion: SCHEMA_VERSION, entries: [] };
const MAX_BINDING_ENTRIES = 128;

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function bindingKey(request: ProjectMapCollectionRequest): string {
  return `${request.projectId}\u0000${request.ownerRootId}\u0000${request.ownerWorkspaceId}`;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 128
    && !hasControlCharacters(value);
}

function validateBinding(value: unknown): value is ProjectMapRootBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return hasExactKeys(item, ['rootAlias', 'rootId', 'workspaceId'])
    && typeof item.rootAlias === 'string'
    && /^[a-z][a-z0-9-]{0,63}$/.test(item.rootAlias)
    && isBoundedString(item.rootId)
    && isBoundedString(item.workspaceId);
}

function validateFile(value: unknown): BindingFile | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ['schemaVersion', 'entries'])) return null;
  const file = record as unknown as Partial<BindingFile>;
  if (file.schemaVersion !== SCHEMA_VERSION
    || !Array.isArray(file.entries)
    || file.entries.length > MAX_BINDING_ENTRIES) return null;
  const keys = new Set<string>();
  for (const entry of file.entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const entryRecord = entry as unknown as Record<string, unknown>;
    if (!hasExactKeys(entryRecord, ['key', 'bindings', 'updatedAt'])) return null;
    const keyParts = typeof entry.key === 'string' ? entry.key.split('\u0000') : [];
    if (keyParts.length !== 3 || !keyParts.every(isBoundedString) || keys.has(entry.key)) return null;
    if (!Array.isArray(entry.bindings)
      || entry.bindings.length > MAX_PROJECT_MAP_ROOTS
      || !entry.bindings.every(validateBinding)) {
      return null;
    }
    if (typeof entry.updatedAt !== 'string' || !Number.isFinite(Date.parse(entry.updatedAt))) return null;
    const aliases = new Set(entry.bindings.map((binding: ProjectMapRootBinding) => binding.rootAlias));
    if (aliases.size !== entry.bindings.length) return null;
    keys.add(entry.key);
  }
  return { schemaVersion: SCHEMA_VERSION, entries: [...file.entries] };
}

export class ProjectMapBindingStore {
  private readonly file: JsonFile;
  private snapshot: BindingFile = EMPTY;

  constructor(userDataDir: string) {
    this.file = new JsonFile(userDataDir, 'project-map-bindings.json');
  }

  async init(): Promise<void> {
    await this.file.init();
    this.snapshot = await this.file.readValidated(validateFile, EMPTY);
  }

  get(request: ProjectMapCollectionRequest): Promise<readonly ProjectMapRootBinding[]> {
    return Promise.resolve(
      this.snapshot.entries.find((entry) => entry.key === bindingKey(request))?.bindings ?? [],
    );
  }

  async set(
    request: ProjectMapCollectionRequest,
    bindings: readonly ProjectMapRootBinding[],
  ): Promise<readonly ProjectMapRootBinding[]> {
    const aliases = new Set(bindings.map((binding) => binding.rootAlias));
    if (bindings.length > MAX_PROJECT_MAP_ROOTS
      || aliases.size !== bindings.length
      || !bindings.every(validateBinding)) {
      throw new Error('Invalid Project Map root bindings.');
    }
    const key = bindingKey(request);
    const next = [...bindings]
      .sort((left, right) => compareText(left.rootAlias, right.rootAlias));
    const result = await this.file.update(
      validateFile,
      EMPTY,
      (current) => ({
        schemaVersion: SCHEMA_VERSION,
        entries: [
          ...current.entries.filter((entry) => entry.key !== key),
          { key, bindings: next, updatedAt: new Date().toISOString() },
        ].slice(-MAX_BINDING_ENTRIES),
      }),
      'set project map bindings',
    );
    if (!result) throw new Error('Could not persist Project Map root bindings.');
    this.snapshot = result;
    return next;
  }

  flush(): Promise<void> {
    return this.file.flush();
  }
}
