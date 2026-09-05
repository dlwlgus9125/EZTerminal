import { createHash } from 'node:crypto';
import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  promises as fileSystem,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DAEMON_DATABASE_FILE_NAME = 'orchestration.sqlite3';
export const DAEMON_RECOVERY_DIRECTORY_NAME = 'orchestration-recovery';
export const DAEMON_MIGRATION_BACKUP_DIRECTORY_NAME = 'migration-backups';
export const DAEMON_QUARANTINE_DIRECTORY_NAME = 'quarantine';

const RECOVERY_MANIFEST_FILE_NAME = 'manifest.json';
const RECOVERY_MATERIAL_DIRECTORY_NAME = 'material';
const RECOVERY_SNAPSHOT_DIRECTORY_NAME = 'snapshot';
const DATABASE_MATERIAL_NAMES = [
  DAEMON_DATABASE_FILE_NAME,
  `${DAEMON_DATABASE_FILE_NAME}-wal`,
  `${DAEMON_DATABASE_FILE_NAME}-shm`,
] as const;
const DATABASE_MATERIAL_NAME_SET = new Set<string>(DATABASE_MATERIAL_NAMES);
const PROBE_FILE_NAME_SET = new Set<string>([
  ...DATABASE_MATERIAL_NAMES,
  `${DAEMON_DATABASE_FILE_NAME}-journal`,
]);
const JSON_FILE_LEGACY_SOURCE_NAMES = [
  'layout.json',
  'presets.json',
  'settings.json',
  'agent-projects.json',
  'agent-coordination.json',
  'agent-collaboration-policy.json',
  'agent-orchestration-runs.json',
  'agent-team-migration.json',
] as const;
const DIRECT_LEGACY_SOURCE_NAMES = [
  'agent-team-catalog.json',
  'agent-team-runs.json',
] as const;
const LEGACY_SOURCE_NAMES = [
  ...JSON_FILE_LEGACY_SOURCE_NAMES,
  ...JSON_FILE_LEGACY_SOURCE_NAMES.map((name) => `${name}.tmp` as const),
  ...JSON_FILE_LEGACY_SOURCE_NAMES.map((name) => `${name}.corrupt` as const),
  ...DIRECT_LEGACY_SOURCE_NAMES,
] as const;
const RECOVERY_SOURCE_NAME_SET = new Set<string>([
  ...DATABASE_MATERIAL_NAMES,
  ...LEGACY_SOURCE_NAMES,
]);
const MAX_RECOVERY_MANIFEST_BYTES = 32 * 1024;
export const MAX_DAEMON_RECOVERY_SET_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_UNIQUE_DIRECTORY_ATTEMPTS = 1_000;
const SQLITE_HEADER_BYTES = 100;
const SQLITE_HEADER_MAGIC = Buffer.from('SQLite format 3\0', 'binary');

type RecoverySetKind = 'pre-migration-backup' | 'initial-legacy-backup' | 'quarantine';
type DatabaseMaterialName = typeof DATABASE_MATERIAL_NAMES[number];
type LegacySourceName = typeof LEGACY_SOURCE_NAMES[number];
type RecoverySourceName = DatabaseMaterialName | LegacySourceName;

interface MaterialFingerprint {
  readonly name: RecoverySourceName;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

interface RecoveryManifest {
  readonly formatVersion: 1;
  readonly kind: RecoverySetKind;
  readonly createdAt: string;
  readonly schemaVersion: number | null;
  readonly files: readonly MaterialFingerprint[];
}

export interface DaemonDatabaseInspection {
  readonly databasePresent: boolean;
  readonly materialNames: readonly DatabaseMaterialName[];
}

export interface DaemonDatabaseProbe {
  readonly schemaVersion: number;
  readonly integrityChecked: boolean;
}

export interface DaemonRecoverySet {
  readonly path: string;
  readonly manifest: RecoveryManifest;
}

export class DaemonRecoveryOperationError extends Error {
  readonly operation: 'backup' | 'quarantine';
  readonly recoveryPath?: string;
  readonly partialMutation: boolean;

  constructor(
    operation: 'backup' | 'quarantine',
    message: string,
    options: { readonly cause?: unknown; readonly recoveryPath?: string; readonly partialMutation?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DaemonRecoveryOperationError';
    this.operation = operation;
    this.recoveryPath = options.recoveryPath;
    this.partialMutation = options.partialMutation ?? false;
  }
}

export interface DaemonStoreRecoveryOptions {
  readonly now: () => Date;
  readonly recoveryIdFactory: () => string;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value).replace(/[\\/]+$/u, '');
    return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  return normalize(left) === normalize(right);
}

function isDirectChild(parent: string, candidate: string): boolean {
  return path.dirname(candidate) === parent && path.basename(candidate) !== '.' && path.basename(candidate) !== '..';
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Owns the narrow filesystem boundary around daemon DB backup and quarantine.
 * It accepts only exact SQLite material and explicitly named legacy JSON files;
 * it never expands globs, walks recursively, or follows links.
 * Copied data and manifests are fsynced before a same-volume atomic rename.
 * Node does not provide a portable Windows directory-fsync contract, so the
 * containing-directory metadata cannot be synchronously forced there.
 */
export class DaemonStoreRecovery {
  private readonly userDataDirectory: string;
  private readonly databasePath: string;
  private readonly now: () => Date;
  private readonly recoveryIdFactory: () => string;

  constructor(userDataDirectory: string, databasePath: string, options: DaemonStoreRecoveryOptions) {
    this.userDataDirectory = path.resolve(userDataDirectory);
    this.databasePath = path.resolve(databasePath);
    this.now = options.now;
    this.recoveryIdFactory = options.recoveryIdFactory;
    if (
      !isDirectChild(this.userDataDirectory, this.databasePath)
      || path.basename(this.databasePath) !== DAEMON_DATABASE_FILE_NAME
    ) {
      throw new Error('Daemon recovery database path escaped the user data directory.');
    }
  }

  prepareUserDataDirectory(): void {
    this.assertPlainDirectoryChain(this.userDataDirectory, true);
    mkdirSync(this.userDataDirectory, { recursive: true });
    this.assertPlainDirectoryChain(this.userDataDirectory, false);
  }

  inspectMaterial(): DaemonDatabaseInspection {
    this.assertPlainDirectory(this.userDataDirectory);
    const materialNames = DATABASE_MATERIAL_NAMES.filter((name) => {
      const candidate = this.sourcePath(name);
      if (!existsSync(candidate)) return false;
      this.assertPlainSourceFile(candidate, name);
      return true;
    });
    return {
      databasePresent: materialNames.includes(DAEMON_DATABASE_FILE_NAME),
      materialNames,
    };
  }

  async probeDatabase(supportedSchemaVersion: number): Promise<DaemonDatabaseProbe> {
    this.assertPlainSourceFile(this.databasePath, DAEMON_DATABASE_FILE_NAME);
    const inspection = this.inspectMaterial();
    if (inspection.materialNames.length === 1) {
      return {
        schemaVersion: await this.readDatabaseHeaderVersion(),
        integrityChecked: false,
      };
    }
    const temporaryRoot = realpathSync.native(os.tmpdir());
    const probeDirectory = await fileSystem.mkdtemp(path.join(temporaryRoot, 'ezterminal-daemon-probe-'));
    if (!isDirectChild(temporaryRoot, probeDirectory) || !path.basename(probeDirectory).startsWith('ezterminal-daemon-probe-')) {
      throw new Error('Daemon database probe directory escaped the OS temporary directory.');
    }
    this.assertPlainDirectory(probeDirectory);
    let database: DatabaseSync | undefined;
    try {
      const sources = await this.captureCurrentMaterial();
      await this.copyAndVerifySources(sources, probeDirectory);
      const probeDatabasePath = path.join(probeDirectory, DAEMON_DATABASE_FILE_NAME);
      database = new DatabaseSync(probeDatabasePath, {
        enableForeignKeyConstraints: false,
        enableDoubleQuotedStringLiterals: false,
        allowExtension: false,
        timeout: 5_000,
      });
      const versionRow = database.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
      const schemaVersion = versionRow?.user_version;
      if (!Number.isSafeInteger(schemaVersion) || (schemaVersion as number) < 0) {
        throw new Error('Unable to read a valid daemon database schema version.');
      }
      if ((schemaVersion as number) > supportedSchemaVersion) {
        return { schemaVersion: schemaVersion as number, integrityChecked: false };
      }
      const quickCheckRow = database.prepare('PRAGMA quick_check(1)').get() as Record<string, unknown> | undefined;
      if (quickCheckRow?.quick_check !== 'ok') {
        throw new Error('Daemon database failed SQLite quick_check.');
      }
      return { schemaVersion: schemaVersion as number, integrityChecked: true };
    } finally {
      try {
        database?.close();
      } finally {
        await this.removeProbeDirectory(temporaryRoot, probeDirectory);
      }
    }
  }

  async createMigrationBackup(schemaVersion: number): Promise<DaemonRecoverySet> {
    let recoveryPath: string | undefined;
    try {
      const sources = await this.captureCurrentMaterial();
      if (!sources.some((file) => file.name === DAEMON_DATABASE_FILE_NAME)) {
        throw new Error('Daemon migration backup requires the database file.');
      }
      const reservation = this.reserveRecoverySet('backup');
      recoveryPath = reservation.pendingPath;
      const materialDirectory = this.createControlledChild(
        reservation.pendingPath,
        RECOVERY_MATERIAL_DIRECTORY_NAME,
      );
      const copied = await this.copyAndVerifySources(sources, materialDirectory);
      const manifest = await this.writeAndVerifyManifest(
        reservation.pendingPath,
        'pre-migration-backup',
        schemaVersion,
        copied,
        [RECOVERY_MATERIAL_DIRECTORY_NAME, RECOVERY_MANIFEST_FILE_NAME],
      );
      await fileSystem.rename(reservation.pendingPath, reservation.finalPath);
      recoveryPath = reservation.finalPath;
      await this.fsyncDirectory(path.dirname(reservation.finalPath));
      this.assertPlainDirectory(reservation.finalPath);
      await this.verifyRecoverySet(reservation.finalPath, manifest, [RECOVERY_MATERIAL_DIRECTORY_NAME]);
      return { path: reservation.finalPath, manifest };
    } catch (error) {
      throw new DaemonRecoveryOperationError(
        'backup',
        'Daemon database migration backup could not be completed and verified.',
        { cause: asError(error), ...(recoveryPath === undefined ? {} : { recoveryPath }) },
      );
    }
  }

  async createInitialLegacyBackup(): Promise<DaemonRecoverySet | undefined> {
    let recoveryPath: string | undefined;
    try {
      const sources = await this.captureLegacySources();
      if (sources.length === 0) return undefined;
      const reservation = this.reserveRecoverySet('legacy');
      recoveryPath = reservation.pendingPath;
      const materialDirectory = this.createControlledChild(
        reservation.pendingPath,
        RECOVERY_MATERIAL_DIRECTORY_NAME,
      );
      const copied = await this.copyAndVerifySources(sources, materialDirectory);
      const manifest = await this.writeAndVerifyManifest(
        reservation.pendingPath,
        'initial-legacy-backup',
        null,
        copied,
        [RECOVERY_MATERIAL_DIRECTORY_NAME, RECOVERY_MANIFEST_FILE_NAME],
      );
      await fileSystem.rename(reservation.pendingPath, reservation.finalPath);
      recoveryPath = reservation.finalPath;
      await this.fsyncDirectory(path.dirname(reservation.finalPath));
      this.assertPlainDirectory(reservation.finalPath);
      await this.verifyRecoverySet(reservation.finalPath, manifest, [RECOVERY_MATERIAL_DIRECTORY_NAME]);
      return { path: reservation.finalPath, manifest };
    } catch (error) {
      throw new DaemonRecoveryOperationError(
        'backup',
        'Legacy orchestration source backup could not be completed and verified.',
        { cause: asError(error), ...(recoveryPath === undefined ? {} : { recoveryPath }) },
      );
    }
  }

  async quarantine(schemaVersion: number | null): Promise<DaemonRecoverySet> {
    let recoveryPath: string | undefined;
    let movedAny = false;
    try {
      const sources = await this.captureCurrentMaterial();
      if (sources.length === 0) throw new Error('No daemon database material exists to quarantine.');
      const reservation = this.reserveRecoverySet('quarantine');
      recoveryPath = reservation.pendingPath;
      const snapshotDirectory = this.createControlledChild(
        reservation.pendingPath,
        RECOVERY_SNAPSHOT_DIRECTORY_NAME,
      );
      const materialDirectory = this.createControlledChild(
        reservation.pendingPath,
        RECOVERY_MATERIAL_DIRECTORY_NAME,
      );
      const copied = await this.copyAndVerifySources(sources, snapshotDirectory);
      this.assertSameFingerprints(copied, await this.captureCurrentMaterial(), 'before quarantine move');
      for (const expected of copied) {
        const source = this.sourcePath(expected.name);
        const destination = path.join(materialDirectory, expected.name);
        this.assertPlainSourceFile(source, expected.name);
        if (existsSync(destination)) throw new Error(`Quarantine destination already exists: ${expected.name}`);
        const current = await this.fingerprintFile(source, expected.name, this.userDataDirectory);
        this.assertSameFingerprints([expected], [current], `before moving ${expected.name}`);
        await fileSystem.rename(source, destination);
        movedAny = true;
      }
      const moved = await this.captureDirectoryMaterial(materialDirectory);
      this.assertSameFingerprints(copied, moved, 'after quarantine move');
      const manifest = await this.writeAndVerifyManifest(
        reservation.pendingPath,
        'quarantine',
        schemaVersion,
        moved,
        [
          RECOVERY_MATERIAL_DIRECTORY_NAME,
          RECOVERY_SNAPSHOT_DIRECTORY_NAME,
          RECOVERY_MANIFEST_FILE_NAME,
        ],
      );
      await this.verifyDirectoryMaterial(snapshotDirectory, manifest.files);
      await fileSystem.rename(reservation.pendingPath, reservation.finalPath);
      recoveryPath = reservation.finalPath;
      await this.fsyncDirectory(path.dirname(reservation.finalPath));
      this.assertPlainDirectory(reservation.finalPath);
      await this.verifyRecoverySet(
        reservation.finalPath,
        manifest,
        [RECOVERY_MATERIAL_DIRECTORY_NAME, RECOVERY_SNAPSHOT_DIRECTORY_NAME],
      );
      return { path: reservation.finalPath, manifest };
    } catch (error) {
      throw new DaemonRecoveryOperationError(
        'quarantine',
        'Daemon database material could not be completely quarantined.',
        {
          cause: asError(error),
          ...(recoveryPath === undefined ? {} : { recoveryPath }),
          partialMutation: movedAny,
        },
      );
    }
  }

  private sourcePath(name: RecoverySourceName): string {
    const candidate = path.join(this.userDataDirectory, name);
    if (!isDirectChild(this.userDataDirectory, candidate) || !RECOVERY_SOURCE_NAME_SET.has(path.basename(candidate))) {
      throw new Error('Daemon recovery source path escaped the user data directory.');
    }
    return candidate;
  }

  private async captureCurrentMaterial(): Promise<readonly MaterialFingerprint[]> {
    const inspection = this.inspectMaterial();
    const fingerprints = await Promise.all(inspection.materialNames.map((name) => (
      this.fingerprintFile(this.sourcePath(name), name, this.userDataDirectory)
    )));
    this.assertTotalSize(fingerprints);
    return fingerprints;
  }

  private async captureLegacySources(): Promise<readonly MaterialFingerprint[]> {
    const names = LEGACY_SOURCE_NAMES.filter((name) => {
      const source = this.sourcePath(name);
      if (!existsSync(source)) return false;
      this.assertPlainSourceFile(source, name);
      return true;
    });
    const fingerprints = await Promise.all(names.map((name) => (
      this.fingerprintFile(this.sourcePath(name), name, this.userDataDirectory)
    )));
    this.assertTotalSize(fingerprints);
    return fingerprints;
  }

  private async captureDirectoryMaterial(directory: string): Promise<readonly MaterialFingerprint[]> {
    this.assertPlainDirectory(directory);
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.length > RECOVERY_SOURCE_NAME_SET.size) {
      throw new Error('Recovery material directory contains too many files.');
    }
    const names = entries.map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink() || !RECOVERY_SOURCE_NAME_SET.has(entry.name)) {
        throw new Error('Recovery material directory contains an unexpected entry.');
      }
      return entry.name as RecoverySourceName;
    }).sort();
    const fingerprints = await Promise.all(names.map((name) => (
      this.fingerprintFile(path.join(directory, name), name, directory)
    )));
    this.assertTotalSize(fingerprints);
    return fingerprints;
  }

  private async copyAndVerifySources(
    sources: readonly MaterialFingerprint[],
    destinationDirectory: string,
  ): Promise<readonly MaterialFingerprint[]> {
    this.assertPlainDirectory(destinationDirectory);
    for (const source of sources) {
      const sourcePath = this.sourcePath(source.name);
      const destinationPath = path.join(destinationDirectory, source.name);
      this.assertPlainSourceFile(sourcePath, source.name);
      await fileSystem.copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
      await this.fsyncFile(destinationPath);
    }
    const copied = await this.captureDirectoryMaterial(destinationDirectory);
    this.assertSameFingerprints(sources, copied, 'after recovery copy', false);
    const sourcesAfterCopy = sources.every((source) => DATABASE_MATERIAL_NAME_SET.has(source.name))
      ? await this.captureCurrentMaterial()
      : await this.captureLegacySources();
    this.assertSameFingerprints(sources, sourcesAfterCopy, 'after source copy');
    const sourceByName = new Map(sources.map((source) => [source.name, source]));
    return copied.map((file) => ({ ...file, mtimeMs: sourceByName.get(file.name)!.mtimeMs }));
  }

  private async fingerprintFile(
    filePath: string,
    name: RecoverySourceName,
    expectedParent: string,
  ): Promise<MaterialFingerprint> {
    if (!isDirectChild(expectedParent, filePath)) throw new Error('Recovery file escaped its expected directory.');
    this.assertPlainSourceFile(filePath, name, expectedParent);
    const handle = await fileSystem.open(filePath, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_DAEMON_RECOVERY_SET_BYTES) {
        throw new Error(`Recovery file has an invalid size: ${name}`);
      }
      const hash = createHash('sha256');
      let bytesRead = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        const value = chunk as Buffer;
        hash.update(value);
        bytesRead += value.byteLength;
      }
      const after = await handle.stat();
      if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error(`Recovery source changed while hashing: ${name}`);
      }
      return { name, size: before.size, mtimeMs: before.mtimeMs, sha256: hash.digest('hex') };
    } finally {
      await handle.close();
    }
  }

  private async readDatabaseHeaderVersion(): Promise<number> {
    this.assertPlainSourceFile(this.databasePath, DAEMON_DATABASE_FILE_NAME);
    const handle = await fileSystem.open(this.databasePath, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size < SQLITE_HEADER_BYTES || before.size > MAX_DAEMON_RECOVERY_SET_BYTES) {
        throw new Error('Daemon file is not a database: invalid SQLite file size.');
      }
      const header = Buffer.alloc(SQLITE_HEADER_BYTES);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      const after = await handle.stat();
      if (bytesRead !== header.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error('Daemon database changed while reading its SQLite header.');
      }
      if (!header.subarray(0, SQLITE_HEADER_MAGIC.length).equals(SQLITE_HEADER_MAGIC)) {
        throw new Error('Daemon file is not a database: invalid SQLite header.');
      }
      const encodedPageSize = header.readUInt16BE(16);
      const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
      if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0) {
        throw new Error('Daemon file is not a database: invalid SQLite page size.');
      }
      return header.readUInt32BE(60);
    } finally {
      await handle.close();
    }
  }

  private assertTotalSize(files: readonly MaterialFingerprint[]): void {
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (!Number.isSafeInteger(total) || total > MAX_DAEMON_RECOVERY_SET_BYTES) {
      throw new Error('Daemon recovery material exceeds the bounded set size.');
    }
  }

  private assertSameFingerprints(
    expected: readonly MaterialFingerprint[],
    actual: readonly MaterialFingerprint[],
    context: string,
    compareMtime = true,
  ): void {
    const sort = (files: readonly MaterialFingerprint[]) => [...files].sort((left, right) => left.name.localeCompare(right.name));
    const left = sort(expected);
    const right = sort(actual);
    if (left.length !== right.length || left.some((file, index) => {
      const candidate = right[index];
      return candidate === undefined
        || candidate.name !== file.name
        || candidate.size !== file.size
        || candidate.sha256 !== file.sha256
        || (compareMtime && candidate.mtimeMs !== file.mtimeMs);
    })) {
      throw new Error(`Daemon recovery material changed ${context}.`);
    }
  }

  private reserveRecoverySet(kind: 'backup' | 'legacy' | 'quarantine'): {
    readonly pendingPath: string;
    readonly finalPath: string;
  } {
    const recoveryRoot = this.ensureControlledDirectory(this.userDataDirectory, DAEMON_RECOVERY_DIRECTORY_NAME);
    const categoryName = kind === 'backup' || kind === 'legacy'
      ? DAEMON_MIGRATION_BACKUP_DIRECTORY_NAME
      : DAEMON_QUARANTINE_DIRECTORY_NAME;
    const categoryRoot = this.ensureControlledDirectory(recoveryRoot, categoryName);
    const timestamp = this.timestampSegment();
    const recoveryId = this.recoveryIdFactory();
    if (typeof recoveryId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(recoveryId)) {
      throw new Error('Daemon recovery id must contain only safe filename characters.');
    }
    for (let attempt = 1; attempt <= MAX_UNIQUE_DIRECTORY_ATTEMPTS; attempt += 1) {
      const suffix = attempt === 1 ? '' : `-${attempt}`;
      const name = `${kind}-${timestamp}-${recoveryId}${suffix}`;
      const finalPath = path.join(categoryRoot, name);
      const pendingPath = path.join(categoryRoot, `.${name}.pending`);
      if (!isDirectChild(categoryRoot, finalPath) || !isDirectChild(categoryRoot, pendingPath)) {
        throw new Error('Daemon recovery set path escaped its category directory.');
      }
      if (existsSync(finalPath) || existsSync(pendingPath)) continue;
      try {
        mkdirSync(pendingPath);
        this.assertPlainDirectory(pendingPath);
        return { pendingPath, finalPath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error('Unable to reserve a unique daemon recovery directory.');
  }

  private ensureControlledDirectory(parent: string, name: string): string {
    this.assertPlainDirectory(parent);
    const directory = path.join(parent, name);
    if (!isDirectChild(parent, directory)) throw new Error('Daemon recovery directory escaped its parent.');
    if (!existsSync(directory)) mkdirSync(directory);
    this.assertPlainDirectory(directory);
    const realParent = realpathSync.native(parent);
    const realDirectory = realpathSync.native(directory);
    if (!samePath(path.dirname(realDirectory), realParent) || path.basename(realDirectory) !== name) {
      throw new Error('Daemon recovery directory traversed a link or reparse point.');
    }
    return directory;
  }

  private createControlledChild(parent: string, name: string): string {
    const directory = path.join(parent, name);
    if (!isDirectChild(parent, directory) || existsSync(directory)) {
      throw new Error('Daemon recovery child directory is unsafe or already exists.');
    }
    mkdirSync(directory);
    this.assertPlainDirectory(directory);
    return directory;
  }

  private async writeAndVerifyManifest(
    setDirectory: string,
    kind: RecoverySetKind,
    schemaVersion: number | null,
    files: readonly MaterialFingerprint[],
    allowedSetEntries: readonly string[],
  ): Promise<RecoveryManifest> {
    const manifest: RecoveryManifest = {
      formatVersion: 1,
      kind,
      createdAt: this.isoNow(),
      schemaVersion,
      files: [...files].sort((left, right) => left.name.localeCompare(right.name)),
    };
    const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > MAX_RECOVERY_MANIFEST_BYTES) {
      throw new Error('Daemon recovery manifest exceeds its size bound.');
    }
    const manifestPath = path.join(setDirectory, RECOVERY_MANIFEST_FILE_NAME);
    if (!isDirectChild(setDirectory, manifestPath)) throw new Error('Daemon recovery manifest escaped its set.');
    writeFileSync(manifestPath, encoded, { encoding: 'utf8', flag: 'wx' });
    await this.fsyncFile(manifestPath);
    this.verifyManifestFile(setDirectory, manifest);
    this.assertDirectoryEntries(setDirectory, allowedSetEntries);
    return manifest;
  }

  private async verifyRecoverySet(
    setDirectory: string,
    expected: RecoveryManifest,
    materialDirectories: readonly string[],
  ): Promise<void> {
    this.verifyManifestFile(setDirectory, expected);
    this.assertDirectoryEntries(setDirectory, [...materialDirectories, RECOVERY_MANIFEST_FILE_NAME]);
    for (const name of materialDirectories) {
      await this.verifyDirectoryMaterial(path.join(setDirectory, name), expected.files);
    }
  }

  private verifyManifestFile(setDirectory: string, expected: RecoveryManifest): void {
    const manifestPath = path.join(setDirectory, RECOVERY_MANIFEST_FILE_NAME);
    this.assertPlainFileInDirectory(manifestPath, setDirectory, RECOVERY_MANIFEST_FILE_NAME);
    const size = statSync(manifestPath).size;
    if (size < 2 || size > MAX_RECOVERY_MANIFEST_BYTES) {
      throw new Error('Daemon recovery manifest has an invalid size.');
    }
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
      throw new Error('Daemon recovery manifest verification failed.');
    }
    if (
      expected.files.length < 1
      || expected.files.length > RECOVERY_SOURCE_NAME_SET.size
      || new Set(expected.files.map((file) => file.name)).size !== expected.files.length
      || expected.files.some((file) => (
        !RECOVERY_SOURCE_NAME_SET.has(file.name)
        || !Number.isSafeInteger(file.size)
        || file.size < 0
        || file.size > MAX_DAEMON_RECOVERY_SET_BYTES
        || !Number.isFinite(file.mtimeMs)
        || !/^[a-f0-9]{64}$/u.test(file.sha256)
      ))
    ) {
      throw new Error('Daemon recovery manifest contains invalid material metadata.');
    }
    this.assertTotalSize(expected.files);
  }

  private async verifyDirectoryMaterial(
    directory: string,
    expected: readonly MaterialFingerprint[],
  ): Promise<void> {
    const actual = await this.captureDirectoryMaterial(directory);
    this.assertSameFingerprints(expected, actual, 'during recovery verification', false);
  }

  private assertDirectoryEntries(directory: string, allowedEntries: readonly string[]): void {
    this.assertPlainDirectory(directory);
    const expected = [...allowedEntries].sort();
    const entries = readdirSync(directory, { withFileTypes: true });
    const actual = entries.map((entry) => entry.name).sort();
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
      throw new Error('Daemon recovery set contains an unexpected entry.');
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        throw new Error('Daemon recovery set contains a link, reparse point, or special file.');
      }
    }
  }

  private assertPlainDirectory(directory: string): void {
    const stats = lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error('Daemon recovery path is not a plain directory.');
    }
  }

  private assertPlainDirectoryChain(directory: string, allowMissingTail: boolean): void {
    const resolved = path.resolve(directory);
    const root = path.parse(resolved).root;
    const segments = path.relative(root, resolved)
      .split(path.sep)
      .filter((segment) => segment.length > 0 && segment !== '.');
    let current = root;
    for (const segment of segments) {
      current = path.join(current, segment);
      if (allowMissingTail && !existsSync(current)) return;
      const stats = lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error('Daemon user data directory must not traverse a link or reparse point.');
      }
    }
  }

  private assertPlainSourceFile(
    filePath: string,
    expectedName: RecoverySourceName,
    expectedParent = this.userDataDirectory,
  ): void {
    this.assertPlainFileInDirectory(filePath, expectedParent, expectedName);
    if (!RECOVERY_SOURCE_NAME_SET.has(expectedName)) {
      throw new Error('Unexpected daemon recovery source name.');
    }
  }

  private async fsyncFile(filePath: string): Promise<void> {
    const handle = await fileSystem.open(filePath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async fsyncDirectory(directory: string): Promise<void> {
    if (process.platform === 'win32') return;
    this.assertPlainDirectory(directory);
    const handle = await fileSystem.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async removeProbeDirectory(temporaryRoot: string, probeDirectory: string): Promise<void> {
    this.assertPlainDirectory(probeDirectory);
    const resolvedRoot = realpathSync.native(temporaryRoot);
    const resolvedProbe = realpathSync.native(probeDirectory);
    if (
      !samePath(path.dirname(resolvedProbe), resolvedRoot)
      || !path.basename(resolvedProbe).startsWith('ezterminal-daemon-probe-')
    ) {
      throw new Error('Daemon probe cleanup path failed containment validation.');
    }
    const entries = readdirSync(probeDirectory, { withFileTypes: true });
    if (entries.length > PROBE_FILE_NAME_SET.size) {
      throw new Error('Daemon probe directory contains too many files to remove safely.');
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !PROBE_FILE_NAME_SET.has(entry.name)) {
        throw new Error('Daemon probe directory contains an unexpected entry; it was preserved.');
      }
      const candidate = path.join(probeDirectory, entry.name);
      this.assertPlainFileInDirectory(candidate, probeDirectory, entry.name);
      await fileSystem.unlink(candidate);
    }
    await fileSystem.rmdir(probeDirectory);
  }

  private assertPlainFileInDirectory(filePath: string, expectedParent: string, expectedName: string): void {
    if (!isDirectChild(expectedParent, filePath) || path.basename(filePath) !== expectedName) {
      throw new Error('Daemon recovery file escaped its expected directory.');
    }
    const stats = lstatSync(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error('Daemon recovery refuses links, reparse points, and special files.');
    }
    const resolvedParent = realpathSync.native(expectedParent);
    const resolvedFile = realpathSync.native(filePath);
    if (!samePath(path.dirname(resolvedFile), resolvedParent) || path.basename(resolvedFile) !== expectedName) {
      throw new Error('Daemon recovery file traversed a link or reparse point.');
    }
  }

  private timestampSegment(): string {
    return this.isoNow().replace(/[-:.]/gu, '');
  }

  private isoNow(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
      throw new Error('Daemon recovery clock returned an invalid Date.');
    }
    return value.toISOString();
  }
}
