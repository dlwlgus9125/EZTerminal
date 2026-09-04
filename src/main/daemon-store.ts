import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import {
  DAEMON_PROTOCOL_VERSION,
  parseDaemonCommand,
  type DaemonAgent,
  type DaemonAgentRelation,
  type DaemonApproval,
  type DaemonCommand,
  type DaemonCommandError,
  type DaemonCommandReceipt,
  type DaemonEvent,
  type DaemonEventKind,
  type DaemonEventPayloads,
  type DaemonHeartbeat,
  type DaemonProject,
  type DaemonProvider,
  type DaemonRuntimeSettings,
  type DaemonSchedule,
  type DaemonSession,
  type DaemonSnapshot,
  type DaemonTranscriptHead,
  type DaemonTranscriptItem,
  type DaemonTurn,
  type DaemonWorkspace,
  type RevisionedRecord,
} from '../shared/daemon-protocol';
import { AsyncMutationGate } from './async-mutation-gate';

export const DAEMON_DATABASE_FILE_NAME = 'orchestration.sqlite3';
export const DAEMON_DATABASE_SCHEMA_VERSION = 3;
export const MAX_TRANSCRIPT_BATCH_ITEMS = 128;
export const MAX_TRANSCRIPT_BATCH_UTF8_BYTES = 1024 * 1024;

type WithoutRevision<T extends RevisionedRecord> = Omit<T, keyof RevisionedRecord>;

export type DaemonProjectInput = WithoutRevision<DaemonProject>;
export type DaemonWorkspaceInput = WithoutRevision<DaemonWorkspace>;
export type DaemonSessionInput = WithoutRevision<DaemonSession>;
export type DaemonAgentInput = WithoutRevision<DaemonAgent>;
export type DaemonAgentRelationInput = WithoutRevision<DaemonAgentRelation>;
export type DaemonTurnInput = WithoutRevision<DaemonTurn>;
export type DaemonApprovalInput = WithoutRevision<DaemonApproval>;
export type DaemonProviderInput = WithoutRevision<DaemonProvider>;
export type DaemonScheduleInput = WithoutRevision<DaemonSchedule>;
export type DaemonHeartbeatInput = WithoutRevision<DaemonHeartbeat>;

export interface DaemonTranscriptItemInput extends Omit<DaemonTranscriptItem, 'sequence' | 'createdAt'> {
  readonly sequence?: number;
  readonly createdAt?: string;
}

export interface DaemonScheduleRunInput {
  readonly id: string;
  readonly scheduleId: string;
  readonly sessionId?: string;
  readonly state: 'queued' | 'running' | 'completed' | 'interrupted' | 'failed';
  readonly scheduledFor: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly summary?: string;
  readonly errorCode?: string;
}

export interface DaemonScheduleRun extends DaemonScheduleRunInput {
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DaemonMigrationReceiptInput {
  readonly id: string;
  readonly source: string;
  readonly fingerprint: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export type DaemonStoreMutation =
  | { readonly kind: 'project.upsert'; readonly value: DaemonProjectInput }
  | { readonly kind: 'workspace.upsert'; readonly value: DaemonWorkspaceInput }
  | { readonly kind: 'session.upsert'; readonly value: DaemonSessionInput }
  | { readonly kind: 'agent.upsert'; readonly value: DaemonAgentInput }
  | { readonly kind: 'agent-relation.upsert'; readonly value: DaemonAgentRelationInput }
  | { readonly kind: 'agent-relation.delete'; readonly relationId: string }
  | { readonly kind: 'turn.upsert'; readonly value: DaemonTurnInput }
  | { readonly kind: 'transcript.append'; readonly items: readonly DaemonTranscriptItemInput[] }
  | { readonly kind: 'approval.upsert'; readonly value: DaemonApprovalInput }
  | { readonly kind: 'provider.upsert'; readonly value: DaemonProviderInput }
  | { readonly kind: 'schedule.upsert'; readonly value: DaemonScheduleInput }
  | { readonly kind: 'schedule.delete'; readonly scheduleId: string }
  | { readonly kind: 'schedule-run.upsert'; readonly value: DaemonScheduleRunInput }
  | { readonly kind: 'heartbeat.upsert'; readonly value: DaemonHeartbeatInput }
  | { readonly kind: 'heartbeat.delete'; readonly sessionId: string }
  | { readonly kind: 'runtime.update'; readonly value: Partial<DaemonRuntimeSettings> }
  | { readonly kind: 'migration-receipt.record'; readonly value: DaemonMigrationReceiptInput };

export type DaemonEventDraft = {
  readonly [K in DaemonEventKind]: {
    readonly kind: K;
    readonly payload: DaemonEventPayloads[K];
  };
}[DaemonEventKind];

export interface DaemonStoreCommit {
  readonly mutations?: readonly DaemonStoreMutation[];
  /** Extra events. Entity, transcript, runtime, and command lifecycle events are generated automatically. */
  readonly events?: readonly DaemonEventDraft[];
  /** Settle crash-recovered commands in the same revision as repaired domain state. */
  readonly reconciledCommands?: readonly {
    readonly commandId: string;
    readonly state: 'applied' | 'delivery-uncertain';
    readonly detail?: string;
  }[];
}

export interface DaemonSystemTransitionState {
  readonly snapshot: DaemonSnapshot;
  readonly scheduleRuns: readonly DaemonScheduleRun[];
}

export interface DaemonSystemTransitionPlan<T> {
  readonly commit: DaemonStoreCommit;
  readonly value: T;
}

export interface DaemonSystemTransitionReceipt<T> {
  readonly applied: boolean;
  readonly revision: number;
  readonly eventSequence: number;
  readonly value: T;
}

export type DaemonSystemTransition<T> = (
  state: DaemonSystemTransitionState,
) => DaemonSystemTransitionPlan<T> | undefined;

export type DaemonOutboxState = 'pending' | 'sent' | 'applied' | 'delivery-uncertain' | 'failed';

export interface DaemonOutboxRecord {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly command: DaemonCommand;
  readonly state: DaemonOutboxState;
  readonly receipt?: DaemonCommandReceipt;
  readonly detail?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sentAt?: string;
  readonly settledAt?: string;
}

export interface DaemonStoreDiagnostics {
  readonly databasePath: string;
  readonly schemaVersion: number;
  readonly journalMode: string;
  readonly foreignKeys: boolean;
}

export interface DaemonStoreOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly maxTranscriptBatchItems?: number;
  readonly maxTranscriptBatchUtf8Bytes?: number;
}

type SqlRow = Record<string, string | number | bigint | null | Uint8Array>;

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS runtime_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    keep_running INTEGER NOT NULL DEFAULT 0 CHECK (keep_running IN (0, 1)),
    start_at_login INTEGER NOT NULL DEFAULT 0 CHECK (start_at_login IN (0, 1)),
    orchestration_tools_enabled INTEGER NOT NULL DEFAULT 0 CHECK (orchestration_tools_enabled IN (0, 1)),
    browser_enabled INTEGER NOT NULL DEFAULT 0 CHECK (browser_enabled IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT,
    source TEXT NOT NULL CHECK (source IN ('native', 'legacy-import')),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('local', 'worktree')),
    root_path TEXT NOT NULL,
    source_workspace_id TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE (id, project_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (source_workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE SET NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    protocol TEXT NOT NULL CHECK (protocol IN ('codex-app-server', 'claude-agent-sdk', 'acp', 'pi-rpc')),
    executable_path TEXT NOT NULL,
    executable_version TEXT NOT NULL,
    argv_json TEXT NOT NULL CHECK (json_valid(argv_json)),
    environment_variable_names_json TEXT NOT NULL CHECK (json_valid(environment_variable_names_json)),
    capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    health TEXT NOT NULL CHECK (health IN ('unknown', 'ready', 'unavailable', 'incompatible', 'error')),
    health_detail TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS command_outbox (
    command_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
    command_type TEXT NOT NULL,
    envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
    state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'applied', 'delivery-uncertain', 'failed')),
    receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
    detail TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sent_at TEXT,
    settled_at TEXT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('agent', 'terminal', 'diff', 'browser', 'script', 'service')),
    title TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('draft', 'starting', 'running', 'idle', 'needs-attention', 'stopping', 'completed', 'interrupted', 'delivery-uncertain', 'failed', 'archived')),
    source TEXT NOT NULL CHECK (source IN ('structured', 'legacy-pty', 'legacy-import')),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    FOREIGN KEY (workspace_id, project_id) REFERENCES workspaces(id, project_id) ON UPDATE CASCADE ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS agents (
    session_id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    provider_session_id TEXT,
    model TEXT,
    permission_preset TEXT NOT NULL CHECK (permission_preset IN ('plan', 'standard', 'full-access')),
    state TEXT NOT NULL CHECK (state IN ('starting', 'queued', 'working', 'blocked', 'idle', 'done', 'interrupted', 'delivery-uncertain', 'error', 'archived')),
    current_turn_id TEXT,
    queued_turn_count INTEGER NOT NULL CHECK (queued_turn_count >= 0),
    orchestration_enabled INTEGER NOT NULL CHECK (orchestration_enabled IN (0, 1)),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (provider_id) REFERENCES providers(id) ON UPDATE CASCADE ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS agent_relations (
    id TEXT PRIMARY KEY,
    tree_id TEXT NOT NULL,
    parent_session_id TEXT NOT NULL,
    child_session_id TEXT NOT NULL,
    owner TEXT NOT NULL CHECK (owner IN ('managed', 'provider-native')),
    depth INTEGER NOT NULL CHECK (depth >= 1),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    detached_at TEXT,
    CHECK (parent_session_id <> child_session_id),
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (child_session_id) REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE CASCADE
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS agent_relations_active_child
    ON agent_relations(child_session_id)
    WHERE detached_at IS NULL AND owner = 'managed';
  CREATE INDEX IF NOT EXISTS agent_relations_tree ON agent_relations(tree_id, depth);

  CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    command_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('queued', 'submitting', 'working', 'blocked', 'completed', 'interrupted', 'delivery-uncertain', 'failed')),
    provider_turn_id TEXT,
    started_at TEXT,
    finished_at TEXT,
    error_code TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (command_id) REFERENCES command_outbox(command_id) ON UPDATE CASCADE ON DELETE RESTRICT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS turns_session_created ON turns(session_id, created_at, id);

  CREATE TABLE IF NOT EXISTS transcript_items (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    kind TEXT NOT NULL CHECK (kind IN ('user-message', 'assistant-message', 'reasoning', 'tool-call', 'tool-result', 'approval', 'child-summary', 'notice', 'error')),
    text TEXT NOT NULL,
    is_delta INTEGER NOT NULL CHECK (is_delta IN (0, 1)),
    is_sensitive INTEGER NOT NULL CHECK (is_sensitive IN (0, 1)),
    related_session_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (session_id, sequence),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (turn_id) REFERENCES turns(id) ON UPDATE CASCADE ON DELETE SET NULL,
    FOREIGN KEY (related_session_id) REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE SET NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS transcript_items_session_sequence ON transcript_items(session_id, sequence);

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT,
    provider_request_id TEXT NOT NULL,
    risk TEXT NOT NULL CHECK (risk IN ('read', 'write', 'danger')),
    title TEXT NOT NULL,
    detail TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'allowed', 'denied', 'expired')),
    resolved_at TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (session_id, provider_request_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (turn_id) REFERENCES turns(id) ON UPDATE CASCADE ON DELETE SET NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT,
    permission_preset TEXT NOT NULL CHECK (permission_preset IN ('plan', 'standard', 'full-access')),
    prompt TEXT NOT NULL,
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    max_runs INTEGER CHECK (max_runs IS NULL OR max_runs > 0),
    run_count INTEGER NOT NULL CHECK (run_count >= 0),
    expires_at TEXT,
    next_run_at TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (provider_id) REFERENCES providers(id) ON UPDATE CASCADE ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS schedule_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    session_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'interrupted', 'failed')),
    scheduled_for TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    summary TEXT,
    error_code TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE SET NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS schedule_runs_schedule_time ON schedule_runs(schedule_id, scheduled_for);

  CREATE TABLE IF NOT EXISTS heartbeats (
    session_id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    pending INTEGER NOT NULL CHECK (pending IN (0, 1)),
    next_run_at TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS revisioned_events (
    sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
    event_id TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    occurred_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
  ) STRICT;

  CREATE INDEX IF NOT EXISTS revisioned_events_revision ON revisioned_events(revision, sequence);

  CREATE TABLE IF NOT EXISTS migration_receipts (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    imported_at TEXT NOT NULL,
    UNIQUE (source, fingerprint)
  ) STRICT;
`;

function requiredString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Corrupt daemon database: ${key} is not text.`);
  return value;
}

function optionalString(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Corrupt daemon database: ${key} is not nullable text.`);
  return value;
}

function integer(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Corrupt daemon database: ${key} is not a safe integer.`);
  }
  return value;
}

function bool(row: SqlRow, key: string): boolean {
  const value = integer(row, key);
  if (value !== 0 && value !== 1) throw new Error(`Corrupt daemon database: ${key} is not boolean.`);
  return value === 1;
}

function stringArray(row: SqlRow, key: string): readonly string[] {
  const parsed = JSON.parse(requiredString(row, key)) as unknown;
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error(`Corrupt daemon database: ${key} is not a string array.`);
  }
  return parsed;
}

function optionalReceipt(row: SqlRow): DaemonCommandReceipt | undefined {
  const json = optionalString(row, 'receipt_json');
  return json === undefined ? undefined : JSON.parse(json) as DaemonCommandReceipt;
}

function runtimeFromRow(row: SqlRow): DaemonRuntimeSettings {
  return {
    keepRunning: bool(row, 'keep_running'),
    startAtLogin: bool(row, 'start_at_login'),
    orchestrationToolsEnabled: bool(row, 'orchestration_tools_enabled'),
    browserEnabled: bool(row, 'browser_enabled'),
  };
}

function outboxFromRow(row: SqlRow): DaemonOutboxRecord {
  const command = parseDaemonCommand(JSON.parse(requiredString(row, 'envelope_json')) as unknown);
  return {
    commandId: requiredString(row, 'command_id'),
    idempotencyKey: requiredString(row, 'idempotency_key'),
    expectedRevision: integer(row, 'expected_revision'),
    command,
    state: requiredString(row, 'state') as DaemonOutboxState,
    ...(optionalReceipt(row) === undefined ? {} : { receipt: optionalReceipt(row) }),
    ...(optionalString(row, 'detail') === undefined ? {} : { detail: optionalString(row, 'detail') }),
    createdAt: requiredString(row, 'created_at'),
    updatedAt: requiredString(row, 'updated_at'),
    ...(optionalString(row, 'sent_at') === undefined ? {} : { sentAt: optionalString(row, 'sent_at') }),
    ...(optionalString(row, 'settled_at') === undefined ? {} : { settledAt: optionalString(row, 'settled_at') }),
  };
}

export function resolveDaemonDatabasePath(userDataDirectory: string): string {
  if (typeof userDataDirectory !== 'string' || userDataDirectory.trim().length === 0 || userDataDirectory.includes('\0')) {
    throw new Error('Daemon user data directory must be a non-empty absolute path.');
  }
  if (!path.isAbsolute(userDataDirectory)) {
    throw new Error('Daemon user data directory must be absolute.');
  }
  const resolvedDirectory = path.resolve(userDataDirectory);
  if (resolvedDirectory === path.parse(resolvedDirectory).root) {
    throw new Error('Daemon database cannot be placed at a filesystem root.');
  }
  const databasePath = path.join(resolvedDirectory, DAEMON_DATABASE_FILE_NAME);
  if (path.dirname(databasePath) !== resolvedDirectory || path.basename(databasePath) !== DAEMON_DATABASE_FILE_NAME) {
    throw new Error('Daemon database path escaped the user data directory.');
  }
  return databasePath;
}

export class DaemonStore {
  readonly databasePath: string;

  private readonly userDataDirectory: string;
  private readonly writer = new AsyncMutationGate();
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly maxTranscriptBatchItems: number;
  private readonly maxTranscriptBatchUtf8Bytes: number;
  private database: DatabaseSync | undefined;
  private state: 'uninitialized' | 'ready' | 'closing' | 'closed' = 'uninitialized';

  constructor(userDataDirectory: string, options: DaemonStoreOptions = {}) {
    this.databasePath = resolveDaemonDatabasePath(userDataDirectory);
    this.userDataDirectory = path.dirname(this.databasePath);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.maxTranscriptBatchItems = this.boundedLimit(
      options.maxTranscriptBatchItems,
      MAX_TRANSCRIPT_BATCH_ITEMS,
      'maxTranscriptBatchItems',
    );
    this.maxTranscriptBatchUtf8Bytes = this.boundedLimit(
      options.maxTranscriptBatchUtf8Bytes,
      MAX_TRANSCRIPT_BATCH_UTF8_BYTES,
      'maxTranscriptBatchUtf8Bytes',
    );
  }

  async init(): Promise<void> {
    await this.writer.runExclusive(() => {
      if (this.state === 'ready') return;
      if (this.state !== 'uninitialized') throw new Error('Daemon store cannot be initialized after closing.');
      mkdirSync(this.userDataDirectory, { recursive: true });
      if (!statSync(this.userDataDirectory).isDirectory()) {
        throw new Error('Daemon user data path is not a directory.');
      }
      const database = new DatabaseSync(this.databasePath, {
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        allowExtension: false,
      });
      try {
        database.exec('PRAGMA busy_timeout = 5000');
        database.exec('PRAGMA foreign_keys = ON');
        database.exec('PRAGMA journal_mode = WAL');
        database.exec('PRAGMA synchronous = FULL');
        this.runMigrations(database);
        this.database = database;
        this.state = 'ready';
        this.recoverUncertainCommandsInTransaction(database);
      } catch (error) {
        database.close();
        this.database = undefined;
        this.state = 'uninitialized';
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    if (this.state === 'uninitialized') {
      this.state = 'closed';
      return;
    }
    if (this.state === 'closing') {
      await this.writer.runExclusive(() => undefined);
      return;
    }
    this.state = 'closing';
    await this.writer.runExclusive(() => {
      const database = this.database;
      this.database = undefined;
      if (database) database.close();
      this.state = 'closed';
    });
  }

  async flush(): Promise<void> {
    await this.writer.runExclusive(() => {
      this.requireDatabase();
    });
  }

  getRevision(): number {
    return this.runtimeRow().revision;
  }

  getEventSequence(): number {
    return this.runtimeRow().eventSequence;
  }

  getDiagnostics(): DaemonStoreDiagnostics {
    const database = this.requireDatabase();
    return {
      databasePath: this.databasePath,
      schemaVersion: this.pragmaInteger(database, 'user_version'),
      journalMode: requiredString(database.prepare('PRAGMA journal_mode').get() as SqlRow, 'journal_mode'),
      foreignKeys: this.pragmaInteger(database, 'foreign_keys') === 1,
    };
  }

  getSnapshot(): DaemonSnapshot {
    const database = this.requireDatabase();
    const runtime = this.runtimeRow(database);
    return {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      revision: runtime.revision,
      eventSequence: runtime.eventSequence,
      generatedAt: this.isoNow(),
      runtime: runtime.settings,
      projects: this.all(database, 'SELECT * FROM projects ORDER BY created_at, id').map((row): DaemonProject => ({
        id: requiredString(row, 'id'), name: requiredString(row, 'name'),
        ...(optionalString(row, 'root_path') === undefined ? {} : { rootPath: optionalString(row, 'root_path') }),
        source: requiredString(row, 'source') as DaemonProject['source'], revision: integer(row, 'revision'),
        createdAt: requiredString(row, 'created_at'), updatedAt: requiredString(row, 'updated_at'),
        ...(optionalString(row, 'archived_at') === undefined ? {} : { archivedAt: optionalString(row, 'archived_at') }),
      })),
      workspaces: this.all(database, 'SELECT * FROM workspaces ORDER BY created_at, id').map((row): DaemonWorkspace => ({
        id: requiredString(row, 'id'), projectId: requiredString(row, 'project_id'), name: requiredString(row, 'name'),
        kind: requiredString(row, 'kind') as DaemonWorkspace['kind'], rootPath: requiredString(row, 'root_path'),
        ...(optionalString(row, 'source_workspace_id') === undefined ? {} : { sourceWorkspaceId: optionalString(row, 'source_workspace_id') }),
        revision: integer(row, 'revision'), createdAt: requiredString(row, 'created_at'), updatedAt: requiredString(row, 'updated_at'),
        ...(optionalString(row, 'archived_at') === undefined ? {} : { archivedAt: optionalString(row, 'archived_at') }),
      })),
      sessions: this.all(database, 'SELECT * FROM sessions ORDER BY created_at, id').map((row): DaemonSession => ({
        id: requiredString(row, 'id'), projectId: requiredString(row, 'project_id'), workspaceId: requiredString(row, 'workspace_id'),
        kind: requiredString(row, 'kind') as DaemonSession['kind'], title: requiredString(row, 'title'),
        state: requiredString(row, 'state') as DaemonSession['state'], source: requiredString(row, 'source') as DaemonSession['source'],
        revision: integer(row, 'revision'), createdAt: requiredString(row, 'created_at'), updatedAt: requiredString(row, 'updated_at'),
        ...(optionalString(row, 'archived_at') === undefined ? {} : { archivedAt: optionalString(row, 'archived_at') }),
      })),
      agents: this.all(database, 'SELECT * FROM agents ORDER BY created_at, session_id').map((row): DaemonAgent => ({
        sessionId: requiredString(row, 'session_id'), providerId: requiredString(row, 'provider_id'),
        ...(optionalString(row, 'provider_session_id') === undefined ? {} : { providerSessionId: optionalString(row, 'provider_session_id') }),
        ...(optionalString(row, 'model') === undefined ? {} : { model: optionalString(row, 'model') }),
        permissionPreset: requiredString(row, 'permission_preset') as DaemonAgent['permissionPreset'],
        state: requiredString(row, 'state') as DaemonAgent['state'],
        ...(optionalString(row, 'current_turn_id') === undefined ? {} : { currentTurnId: optionalString(row, 'current_turn_id') }),
        queuedTurnCount: integer(row, 'queued_turn_count'), orchestrationEnabled: bool(row, 'orchestration_enabled'),
        revision: integer(row, 'revision'), createdAt: requiredString(row, 'created_at'), updatedAt: requiredString(row, 'updated_at'),
      })),
      agentRelations: this.all(database, 'SELECT * FROM agent_relations ORDER BY created_at, id').map((row): DaemonAgentRelation => ({
        id: requiredString(row, 'id'), treeId: requiredString(row, 'tree_id'),
        parentSessionId: requiredString(row, 'parent_session_id'), childSessionId: requiredString(row, 'child_session_id'),
        owner: requiredString(row, 'owner') as DaemonAgentRelation['owner'], depth: integer(row, 'depth'),
        revision: integer(row, 'revision'), createdAt: requiredString(row, 'created_at'), updatedAt: requiredString(row, 'updated_at'),
        ...(optionalString(row, 'detached_at') === undefined ? {} : { detachedAt: optionalString(row, 'detached_at') }),
      })),
      turns: this.all(database, 'SELECT * FROM turns ORDER BY created_at, id').map((row): DaemonTurn => ({
        id: requiredString(row, 'id'), sessionId: requiredString(row, 'session_id'), commandId: requiredString(row, 'command_id'),
        ...(row.enqueue_sequence === null ? {} : { enqueueSequence: integer(row, 'enqueue_sequence') }),
        state: requiredString(row, 'state') as DaemonTurn['state'],
        ...(optionalString(row, 'provider_turn_id') === undefined ? {} : { providerTurnId: optionalString(row, 'provider_turn_id') }),
        ...(optionalString(row, 'started_at') === undefined ? {} : { startedAt: optionalString(row, 'started_at') }),
        ...(optionalString(row, 'finished_at') === undefined ? {} : { finishedAt: optionalString(row, 'finished_at') }),
        ...(optionalString(row, 'error_code') === undefined ? {} : { errorCode: optionalString(row, 'error_code') }),
        revision: integer(row, 'revision'), createdAt: requiredString(row, 'created_at'), updatedAt: requiredString(row, 'updated_at'),
      })),
      transcriptHeads: this.all(database, `
        SELECT session_id, MAX(sequence) AS last_sequence, COUNT(*) AS item_count
        FROM transcript_items GROUP BY session_id ORDER BY session_id
      `).map((row): DaemonTranscriptHead => ({
        sessionId: requiredString(row, 'session_id'), lastSequence: integer(row, 'last_sequence'), itemCount: integer(row, 'item_count'),
      })),
      approvals: this.all(database, 'SELECT * FROM approvals ORDER BY created_at, id').map((row): DaemonApproval => ({
        id: requiredString(row, 'id'), sessionId: requiredString(row, 'session_id'),
        ...(optionalString(row, 'turn_id') === undefined ? {} : { turnId: optionalString(row, 'turn_id') }),
        providerRequestId: requiredString(row, 'provider_request_id'), risk: requiredString(row, 'risk') as DaemonApproval['risk'],
        title: requiredString(row, 'title'), ...(optionalString(row, 'detail') === undefined ? {} : { detail: optionalString(row, 'detail') }),
        state: requiredString(row, 'state') as DaemonApproval['state'],
        ...(optionalString(row, 'resolved_at') === undefined ? {} : { resolvedAt: optionalString(row, 'resolved_at') }),
        revision: integer(row, 'revision'), createdAt: requiredString(row, 'created_at'), updatedAt: requiredString(row, 'updated_at'),
      })),
      providers: this.all(database, 'SELECT * FROM providers ORDER BY created_at, id').map((row): DaemonProvider => ({
        id: requiredString(row, 'id'), displayName: requiredString(row, 'display_name'),
        protocol: requiredString(row, 'protocol') as DaemonProvider['protocol'], executablePath: requiredString(row, 'executable_path'),
        executableVersion: requiredString(row, 'executable_version'), argv: stringArray(row, 'argv_json'),
        environmentVariableNames: stringArray(row, 'environment_variable_names_json'), capabilities: stringArray(row, 'capabilities_json'),
        ...(optionalString(row, 'review_digest') === undefined ? {} : { reviewDigest: optionalString(row, 'review_digest') }),
        enabled: bool(row, 'enabled'), health: requiredString(row, 'health') as DaemonProvider['health'],
        ...(optionalString(row, 'health_detail') === undefined ? {} : { healthDetail: optionalString(row, 'health_detail') }),
        revision: integer(row, 'revision'), createdAt: requiredString(row, 'created_at'), updatedAt: requiredString(row, 'updated_at'),
      })),
      schedules: this.all(database, 'SELECT * FROM schedules ORDER BY created_at, id').map((row): DaemonSchedule => ({
        id: requiredString(row, 'id'), name: requiredString(row, 'name'), workspaceId: requiredString(row, 'workspace_id'),
        providerId: requiredString(row, 'provider_id'), ...(optionalString(row, 'model') === undefined ? {} : { model: optionalString(row, 'model') }),
        permissionPreset: requiredString(row, 'permission_preset') as DaemonSchedule['permissionPreset'],
        prompt: requiredString(row, 'prompt'), cron: requiredString(row, 'cron'), timezone: requiredString(row, 'timezone'),
        enabled: bool(row, 'enabled'), ...(row.max_runs === null ? {} : { maxRuns: integer(row, 'max_runs') }), runCount: integer(row, 'run_count'),
        ...(optionalString(row, 'expires_at') === undefined ? {} : { expiresAt: optionalString(row, 'expires_at') }),
        ...(optionalString(row, 'next_run_at') === undefined ? {} : { nextRunAt: optionalString(row, 'next_run_at') }),
        revision: integer(row, 'revision'), createdAt: requiredString(row, 'created_at'), updatedAt: requiredString(row, 'updated_at'),
      })),
      heartbeats: this.all(database, 'SELECT * FROM heartbeats ORDER BY created_at, session_id').map((row): DaemonHeartbeat => ({
        sessionId: requiredString(row, 'session_id'), prompt: requiredString(row, 'prompt'), cron: requiredString(row, 'cron'),
        timezone: requiredString(row, 'timezone'), enabled: bool(row, 'enabled'), pending: bool(row, 'pending'),
        ...(optionalString(row, 'next_run_at') === undefined ? {} : { nextRunAt: optionalString(row, 'next_run_at') }),
        revision: integer(row, 'revision'), createdAt: requiredString(row, 'created_at'), updatedAt: requiredString(row, 'updated_at'),
      })),
    };
  }

  getScheduleRuns(
    states?: readonly DaemonScheduleRun['state'][],
  ): readonly DaemonScheduleRun[] {
    const database = this.requireDatabase();
    const rows = states === undefined
      ? this.all(database, 'SELECT * FROM schedule_runs ORDER BY created_at, id')
      : states.length === 0
        ? []
        : this.all(
            database,
            `SELECT * FROM schedule_runs WHERE state IN (${states.map(() => '?').join(', ')}) ORDER BY created_at, id`,
            ...states,
          );
    return rows.map((row): DaemonScheduleRun => ({
      id: requiredString(row, 'id'),
      scheduleId: requiredString(row, 'schedule_id'),
      ...(optionalString(row, 'session_id') === undefined
        ? {}
        : { sessionId: optionalString(row, 'session_id') }),
      state: requiredString(row, 'state') as DaemonScheduleRun['state'],
      scheduledFor: requiredString(row, 'scheduled_for'),
      ...(optionalString(row, 'started_at') === undefined
        ? {}
        : { startedAt: optionalString(row, 'started_at') }),
      ...(optionalString(row, 'finished_at') === undefined
        ? {}
        : { finishedAt: optionalString(row, 'finished_at') }),
      ...(optionalString(row, 'summary') === undefined
        ? {}
        : { summary: optionalString(row, 'summary') }),
      ...(optionalString(row, 'error_code') === undefined
        ? {}
        : { errorCode: optionalString(row, 'error_code') }),
      revision: integer(row, 'revision'),
      createdAt: requiredString(row, 'created_at'),
      updatedAt: requiredString(row, 'updated_at'),
    }));
  }

  getTranscript(sessionId: string, afterSequence = 0, limit = 500): readonly DaemonTranscriptItem[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('afterSequence must be a non-negative integer.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_000) throw new Error('Transcript limit must be between 1 and 2000.');
    return this.all(
      this.requireDatabase(),
      `SELECT * FROM transcript_items WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
      sessionId,
      afterSequence,
      limit,
    ).map((row): DaemonTranscriptItem => ({
      id: requiredString(row, 'id'), sessionId: requiredString(row, 'session_id'),
      ...(optionalString(row, 'turn_id') === undefined ? {} : { turnId: optionalString(row, 'turn_id') }),
      sequence: integer(row, 'sequence'), kind: requiredString(row, 'kind') as DaemonTranscriptItem['kind'],
      text: requiredString(row, 'text'), isDelta: bool(row, 'is_delta'), isSensitive: bool(row, 'is_sensitive'),
      ...(optionalString(row, 'related_session_id') === undefined ? {} : { relatedSessionId: optionalString(row, 'related_session_id') }),
      createdAt: requiredString(row, 'created_at'),
    }));
  }

  listEventsAfter(sequence: number, limit = 1_000): readonly DaemonEvent[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Event sequence must be a non-negative integer.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) throw new Error('Event limit must be between 1 and 5000.');
    return this.all(
      this.requireDatabase(),
      'SELECT * FROM revisioned_events WHERE sequence > ? ORDER BY sequence LIMIT ?',
      sequence,
      limit,
    ).map((row) => ({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      eventId: requiredString(row, 'event_id'), sequence: integer(row, 'sequence'), revision: integer(row, 'revision'),
      occurredAt: requiredString(row, 'occurred_at'), kind: requiredString(row, 'kind') as DaemonEventKind,
      payload: JSON.parse(requiredString(row, 'payload_json')) as DaemonEvent['payload'],
    }) as DaemonEvent);
  }

  findCommandByIdempotencyKey(idempotencyKey: string): DaemonOutboxRecord | undefined {
    const row = this.requireDatabase().prepare(
      'SELECT * FROM command_outbox WHERE idempotency_key = ?',
    ).get(idempotencyKey) as SqlRow | undefined;
    return row === undefined ? undefined : outboxFromRow(row);
  }

  findCommand(commandId: string): DaemonOutboxRecord | undefined {
    const row = this.requireDatabase().prepare(
      'SELECT * FROM command_outbox WHERE command_id = ?',
    ).get(commandId) as SqlRow | undefined;
    return row === undefined ? undefined : outboxFromRow(row);
  }

  beginOutbox(commandValue: DaemonCommand): Promise<DaemonOutboxRecord> {
    const command = parseDaemonCommand(commandValue);
    return this.writer.runExclusive(() => {
      const database = this.requireDatabase();
      const existing = database.prepare('SELECT * FROM command_outbox WHERE idempotency_key = ?')
        .get(command.idempotencyKey) as SqlRow | undefined;
      if (existing) return outboxFromRow(existing);
      const duplicateCommandId = database.prepare('SELECT idempotency_key FROM command_outbox WHERE command_id = ?')
        .get(command.commandId) as SqlRow | undefined;
      if (duplicateCommandId) throw new Error(`Command id ${command.commandId} already has another idempotency key.`);

      const currentRevision = this.runtimeRow(database).revision;
      const now = this.isoNow();
      const conflict = command.expectedRevision !== currentRevision;
      const receipt: DaemonCommandReceipt | undefined = conflict ? {
        ok: false,
        status: 'rejected',
        commandId: command.commandId,
        revision: currentRevision,
        error: {
          code: 'revision-conflict',
          message: `Expected daemon revision ${command.expectedRevision}, but current revision is ${currentRevision}.`,
          retryable: true,
          currentRevision,
        },
      } : undefined;
      database.prepare(`
        INSERT INTO command_outbox (
          command_id, idempotency_key, expected_revision, command_type, envelope_json, state,
          receipt_json, detail, created_at, updated_at, settled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        command.commandId,
        command.idempotencyKey,
        command.expectedRevision,
        command.type,
        JSON.stringify(command),
        conflict ? 'failed' : 'pending',
        receipt === undefined ? null : JSON.stringify(receipt),
        conflict ? 'revision-conflict' : null,
        now,
        now,
        conflict ? now : null,
      );
      return this.findCommandOrThrow(database, command.commandId);
    });
  }

  markOutboxSent(commandId: string): Promise<DaemonOutboxRecord> {
    return this.writer.runExclusive(() => {
      const database = this.requireDatabase();
      const current = this.findCommandOrThrow(database, commandId);
      if (current.state !== 'pending') return current;
      const now = this.isoNow();
      database.prepare(`
        UPDATE command_outbox SET state = 'sent', sent_at = ?, updated_at = ? WHERE command_id = ? AND state = 'pending'
      `).run(now, now, commandId);
      return this.findCommandOrThrow(database, commandId);
    });
  }

  commitCommand(commandId: string, commit: DaemonStoreCommit = {}): Promise<DaemonCommandReceipt> {
    return this.writer.runExclusive(() => {
      const database = this.requireDatabase();
      const current = this.findCommandOrThrow(database, commandId);
      const settledReceipt = this.replayedReceipt(current);
      if (settledReceipt) return settledReceipt;
      const runtime = this.runtimeRow(database);
      if (current.expectedRevision !== runtime.revision) {
        const receipt: DaemonCommandReceipt = {
          ok: false,
          status: 'rejected',
          commandId,
          revision: runtime.revision,
          error: {
            code: 'revision-conflict',
            message: `Expected daemon revision ${current.expectedRevision}, but current revision is ${runtime.revision}.`,
            retryable: true,
            currentRevision: runtime.revision,
          },
        };
        const now = this.isoNow();
        database.prepare(`
          UPDATE command_outbox
          SET state = 'failed', receipt_json = ?, detail = 'revision-conflict', updated_at = ?, settled_at = ?
          WHERE command_id = ?
        `).run(JSON.stringify(receipt), now, now, commandId);
        return receipt;
      }

      const revision = runtime.revision + 1;
      const now = this.isoNow();
      database.exec('BEGIN IMMEDIATE');
      try {
        const generatedEvents: DaemonEventDraft[] = [];
        for (const mutation of commit.mutations ?? []) {
          generatedEvents.push(...this.applyMutation(database, mutation, revision, now));
        }
        generatedEvents.push(...(commit.events ?? []));
        generatedEvents.push({ kind: 'command.changed', payload: { commandId, state: 'applied' } });
        const eventSequence = this.appendEvents(database, generatedEvents, revision, runtime.eventSequence, now);
        const receipt: DaemonCommandReceipt = {
          ok: true,
          status: 'applied',
          commandId,
          revision,
          eventSequence,
        };
        database.prepare(`
          UPDATE runtime_settings SET revision = ?, event_sequence = ?, updated_at = ? WHERE singleton = 1
        `).run(revision, eventSequence, now);
        database.prepare(`
          UPDATE command_outbox
          SET state = 'applied', receipt_json = ?, detail = NULL, updated_at = ?, settled_at = ?
          WHERE command_id = ? AND state IN ('pending', 'sent')
        `).run(JSON.stringify(receipt), now, now, commandId);
        database.exec('COMMIT');
        return receipt;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async applySystemCommit(
    commit: DaemonStoreCommit,
  ): Promise<{ readonly revision: number; readonly eventSequence: number }> {
    const receipt = await this.applySystemTransition(() => ({ commit, value: undefined }));
    return receipt
      ? { revision: receipt.revision, eventSequence: receipt.eventSequence }
      : { revision: this.getRevision(), eventSequence: this.getEventSequence() };
  }

  /**
   * Decide and persist a system claim under the same SQLite write lock. The
   * planner is synchronous by design: provider, network, and timer work cannot
   * run while the authoritative transaction is open.
   */
  applySystemTransition<T>(
    transition: DaemonSystemTransition<T>,
  ): Promise<DaemonSystemTransitionReceipt<T> | undefined> {
    return this.writer.runExclusive(() => {
      const database = this.requireDatabase();
      database.exec('BEGIN IMMEDIATE');
      try {
        const runtime = this.runtimeRow(database);
        const plan = transition({
          snapshot: this.getSnapshot(),
          scheduleRuns: this.getScheduleRuns(),
        });
        if (!plan) {
          database.exec('COMMIT');
          return undefined;
        }
        const commit = plan.commit;
        const hasChanges = (commit.mutations?.length ?? 0) > 0
          || (commit.events?.length ?? 0) > 0
          || (commit.reconciledCommands?.length ?? 0) > 0;
        if (!hasChanges) {
          database.exec('COMMIT');
          return {
            applied: false,
            revision: runtime.revision,
            eventSequence: runtime.eventSequence,
            value: plan.value,
          };
        }
        const revision = runtime.revision + 1;
        const now = this.isoNow();
        const generatedEvents: DaemonEventDraft[] = [];
        for (const mutation of commit.mutations ?? []) {
          generatedEvents.push(...this.applyMutation(database, mutation, revision, now));
        }
        const commandReconciliations = (commit.reconciledCommands ?? []).flatMap((reconciliation) => {
          const row = database.prepare('SELECT * FROM command_outbox WHERE command_id = ?')
            .get(reconciliation.commandId) as SqlRow | undefined;
          const record = row ? outboxFromRow(row) : undefined;
          if (!record || record.state !== 'delivery-uncertain') return [];
          if (reconciliation.state === 'applied') {
            generatedEvents.push({
              kind: 'command.changed',
              payload: { commandId: reconciliation.commandId, state: 'applied' },
            });
          }
          return [{ reconciliation, record }];
        });
        generatedEvents.push(...(commit.events ?? []));
        const eventSequence = this.appendEvents(
          database,
          generatedEvents,
          revision,
          runtime.eventSequence,
          now,
        );
        for (const { reconciliation } of commandReconciliations) {
          if (reconciliation.state === 'applied') {
            const receipt: DaemonCommandReceipt = {
              ok: true,
              status: 'applied',
              commandId: reconciliation.commandId,
              revision,
              eventSequence,
            };
            database.prepare(`
              UPDATE command_outbox
              SET state = 'applied', receipt_json = ?, detail = NULL, updated_at = ?, settled_at = ?
              WHERE command_id = ? AND state = 'delivery-uncertain'
            `).run(JSON.stringify(receipt), now, now, reconciliation.commandId);
          } else if (reconciliation.detail) {
            database.prepare(`
              UPDATE command_outbox SET detail = ?, updated_at = ?
              WHERE command_id = ? AND state = 'delivery-uncertain'
            `).run(reconciliation.detail, now, reconciliation.commandId);
          }
        }
        database.prepare(
          'UPDATE runtime_settings SET revision = ?, event_sequence = ?, updated_at = ? WHERE singleton = 1',
        ).run(revision, eventSequence, now);
        database.exec('COMMIT');
        return { applied: true, revision, eventSequence, value: plan.value };
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    });
  }

  appendTranscriptBatch(items: readonly DaemonTranscriptItemInput[]): Promise<{ readonly revision: number; readonly eventSequence: number }> {
    return this.applySystemCommit({ mutations: [{ kind: 'transcript.append', items }] });
  }

  markDeliveryUncertain(commandId: string, detail = 'Provider delivery could not be reconciled after interruption.'):
  Promise<DaemonCommandReceipt> {
    return this.writer.runExclusive(() => {
      const database = this.requireDatabase();
      const current = this.findCommandOrThrow(database, commandId);
      const settled = this.replayedReceipt(current);
      if (settled) return settled;
      return this.markCommandsDeliveryUncertain(database, [current], detail)[0]!;
    });
  }

  rejectCommand(commandId: string, error: DaemonCommandError): Promise<DaemonCommandReceipt> {
    return this.writer.runExclusive(() => {
      const database = this.requireDatabase();
      const current = this.findCommandOrThrow(database, commandId);
      const settled = this.replayedReceipt(current);
      if (settled) return settled;
      const revision = this.runtimeRow(database).revision;
      const receipt: DaemonCommandReceipt = {
        ok: false,
        status: error.code === 'delivery-uncertain' ? 'delivery-uncertain' : 'rejected',
        commandId,
        revision,
        error,
      };
      const now = this.isoNow();
      database.prepare(`
        UPDATE command_outbox
        SET state = ?, receipt_json = ?, detail = ?, updated_at = ?, settled_at = ?
        WHERE command_id = ? AND state IN ('pending', 'sent')
      `).run(
        receipt.status === 'delivery-uncertain' ? 'delivery-uncertain' : 'failed',
        JSON.stringify(receipt),
        error.code,
        now,
        now,
        commandId,
      );
      return receipt;
    });
  }

  recoverUncertainCommands(): Promise<readonly DaemonOutboxRecord[]> {
    return this.writer.runExclusive(() => this.recoverUncertainCommandsInTransaction(this.requireDatabase()));
  }

  private boundedLimit(value: number | undefined, maximum: number, name: string): number {
    const resolved = value ?? maximum;
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
      throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
    }
    return resolved;
  }

  private requireDatabase(): DatabaseSync {
    if (this.state !== 'ready' || !this.database) throw new Error('Daemon store is not open.');
    return this.database;
  }

  private isoNow(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) throw new Error('Daemon store clock returned an invalid Date.');
    return value.toISOString();
  }

  private runMigrations(database: DatabaseSync): void {
    const version = this.pragmaInteger(database, 'user_version');
    if (version > DAEMON_DATABASE_SCHEMA_VERSION) {
      throw new Error(`Daemon database schema ${version} is newer than supported schema ${DAEMON_DATABASE_SCHEMA_VERSION}.`);
    }
    if (version < 1) {
      const now = this.isoNow();
      database.exec('BEGIN IMMEDIATE');
      try {
        database.exec(SCHEMA_V1);
        database.prepare(`
          INSERT OR IGNORE INTO runtime_settings (singleton, created_at, updated_at) VALUES (1, ?, ?)
        `).run(now, now);
        database.exec('PRAGMA user_version = 1');
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
    if (version < 2) {
      database.exec('BEGIN IMMEDIATE');
      try {
        database.exec(`
          ALTER TABLE turns ADD COLUMN enqueue_sequence INTEGER CHECK (enqueue_sequence IS NULL OR enqueue_sequence > 0);
          UPDATE turns SET enqueue_sequence = rowid WHERE enqueue_sequence IS NULL;
          CREATE INDEX turns_fifo_queue ON turns(state, enqueue_sequence, id);
          CREATE INDEX transcript_items_turn_kind ON transcript_items(turn_id, kind, sequence);
          PRAGMA user_version = 2;
        `);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
    if (version < 3) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const reviewDigestColumn = database.prepare(
          "SELECT name FROM pragma_table_info('providers') WHERE name = 'review_digest'",
        ).get();
        if (!reviewDigestColumn) {
          database.exec('ALTER TABLE providers ADD COLUMN review_digest TEXT');
        }
        database.exec('PRAGMA user_version = 3');
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
    const row = database.prepare('SELECT singleton FROM runtime_settings WHERE singleton = 1').get();
    if (!row) throw new Error('Daemon database is missing runtime metadata.');
  }

  private pragmaInteger(database: DatabaseSync, pragma: 'user_version' | 'foreign_keys'): number {
    const row = database.prepare(`PRAGMA ${pragma}`).get() as SqlRow | undefined;
    if (!row) throw new Error(`Unable to read SQLite ${pragma}.`);
    return integer(row, pragma);
  }

  private runtimeRow(database = this.requireDatabase()): {
    readonly revision: number;
    readonly eventSequence: number;
    readonly settings: DaemonRuntimeSettings;
  } {
    const row = database.prepare('SELECT * FROM runtime_settings WHERE singleton = 1').get() as SqlRow | undefined;
    if (!row) throw new Error('Daemon database is missing runtime metadata.');
    return { revision: integer(row, 'revision'), eventSequence: integer(row, 'event_sequence'), settings: runtimeFromRow(row) };
  }

  private all(database: DatabaseSync, sql: string, ...params: SQLInputValue[]): readonly SqlRow[] {
    return database.prepare(sql).all(...params) as SqlRow[];
  }

  private findCommandOrThrow(database: DatabaseSync, commandId: string): DaemonOutboxRecord {
    const row = database.prepare('SELECT * FROM command_outbox WHERE command_id = ?').get(commandId) as SqlRow | undefined;
    if (!row) throw new Error(`Daemon command ${commandId} was not found in the outbox.`);
    return outboxFromRow(row);
  }

  private replayedReceipt(record: DaemonOutboxRecord): DaemonCommandReceipt | undefined {
    if (record.state === 'pending' || record.state === 'sent') return undefined;
    if (!record.receipt) throw new Error(`Settled daemon command ${record.commandId} has no receipt.`);
    if (record.receipt.ok && record.state === 'applied') return { ...record.receipt, status: 'replayed' };
    return record.receipt;
  }

  private appendEvents(
    database: DatabaseSync,
    drafts: readonly DaemonEventDraft[],
    revision: number,
    previousSequence: number,
    occurredAt: string,
  ): number {
    const insert = database.prepare(`
      INSERT INTO revisioned_events (sequence, event_id, revision, occurred_at, kind, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    let sequence = previousSequence;
    for (const draft of drafts) {
      sequence += 1;
      insert.run(sequence, this.idFactory(), revision, occurredAt, draft.kind, JSON.stringify(draft.payload));
    }
    return sequence;
  }

  private applyMutation(
    database: DatabaseSync,
    mutation: DaemonStoreMutation,
    revision: number,
    now: string,
  ): readonly DaemonEventDraft[] {
    switch (mutation.kind) {
      case 'project.upsert': {
        const value = mutation.value;
        database.prepare(`
          INSERT INTO projects (id, name, root_path, source, revision, created_at, updated_at, archived_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name, root_path = excluded.root_path, source = excluded.source,
            revision = excluded.revision, updated_at = excluded.updated_at, archived_at = excluded.archived_at
        `).run(value.id, value.name, value.rootPath ?? null, value.source, revision, now, now, value.archivedAt ?? null);
        return [{
          kind: value.archivedAt === undefined ? 'entity.upserted' : 'entity.archived',
          payload: value.archivedAt === undefined
            ? { entityType: 'project', entityId: value.id }
            : { entityType: 'project', entityId: value.id },
        } as DaemonEventDraft];
      }
      case 'workspace.upsert': {
        const value = mutation.value;
        database.prepare(`
          INSERT INTO workspaces (
            id, project_id, name, kind, root_path, source_workspace_id, revision, created_at, updated_at, archived_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id, name = excluded.name, kind = excluded.kind, root_path = excluded.root_path,
            source_workspace_id = excluded.source_workspace_id, revision = excluded.revision,
            updated_at = excluded.updated_at, archived_at = excluded.archived_at
        `).run(
          value.id, value.projectId, value.name, value.kind, value.rootPath, value.sourceWorkspaceId ?? null,
          revision, now, now, value.archivedAt ?? null,
        );
        return [{
          kind: value.archivedAt === undefined ? 'entity.upserted' : 'entity.archived',
          payload: { entityType: 'workspace', entityId: value.id },
        } as DaemonEventDraft];
      }
      case 'session.upsert': {
        const value = mutation.value;
        database.prepare(`
          INSERT INTO sessions (
            id, project_id, workspace_id, kind, title, state, source, revision, created_at, updated_at, archived_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id, workspace_id = excluded.workspace_id, kind = excluded.kind,
            title = excluded.title, state = excluded.state, source = excluded.source,
            revision = excluded.revision, updated_at = excluded.updated_at, archived_at = excluded.archived_at
        `).run(
          value.id, value.projectId, value.workspaceId, value.kind, value.title, value.state, value.source,
          revision, now, now, value.archivedAt ?? null,
        );
        return [{
          kind: value.archivedAt === undefined && value.state !== 'archived' ? 'entity.upserted' : 'entity.archived',
          payload: { entityType: 'session', entityId: value.id },
        } as DaemonEventDraft];
      }
      case 'agent.upsert': {
        const value = mutation.value;
        database.prepare(`
          INSERT INTO agents (
            session_id, provider_id, provider_session_id, model, permission_preset, state, current_turn_id,
            queued_turn_count, orchestration_enabled, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            provider_id = excluded.provider_id, provider_session_id = excluded.provider_session_id,
            model = excluded.model, permission_preset = excluded.permission_preset, state = excluded.state,
            current_turn_id = excluded.current_turn_id, queued_turn_count = excluded.queued_turn_count,
            orchestration_enabled = excluded.orchestration_enabled, revision = excluded.revision, updated_at = excluded.updated_at
        `).run(
          value.sessionId, value.providerId, value.providerSessionId ?? null, value.model ?? null,
          value.permissionPreset, value.state, value.currentTurnId ?? null, value.queuedTurnCount,
          value.orchestrationEnabled ? 1 : 0, revision, now, now,
        );
        return [{ kind: 'entity.upserted', payload: { entityType: 'agent', entityId: value.sessionId } }];
      }
      case 'agent-relation.upsert': {
        const value = mutation.value;
        database.prepare(`
          INSERT INTO agent_relations (
            id, tree_id, parent_session_id, child_session_id, owner, depth, revision, created_at, updated_at, detached_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            tree_id = excluded.tree_id, parent_session_id = excluded.parent_session_id,
            child_session_id = excluded.child_session_id, owner = excluded.owner, depth = excluded.depth,
            revision = excluded.revision, updated_at = excluded.updated_at, detached_at = excluded.detached_at
        `).run(
          value.id, value.treeId, value.parentSessionId, value.childSessionId, value.owner,
          value.depth, revision, now, now, value.detachedAt ?? null,
        );
        return [{ kind: 'entity.upserted', payload: { entityType: 'relation', entityId: value.id } }];
      }
      case 'agent-relation.delete':
        database.prepare('DELETE FROM agent_relations WHERE id = ?').run(mutation.relationId);
        return [{ kind: 'entity.upserted', payload: { entityType: 'relation', entityId: mutation.relationId } }];
      case 'turn.upsert': {
        const value = mutation.value;
        database.prepare(`
          INSERT INTO turns (
            id, session_id, command_id, enqueue_sequence, state, provider_turn_id, started_at, finished_at,
            error_code, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            session_id = excluded.session_id, command_id = excluded.command_id,
            enqueue_sequence = COALESCE(turns.enqueue_sequence, excluded.enqueue_sequence), state = excluded.state,
            provider_turn_id = excluded.provider_turn_id, started_at = excluded.started_at,
            finished_at = excluded.finished_at, error_code = excluded.error_code,
            revision = excluded.revision, updated_at = excluded.updated_at
        `).run(
          value.id, value.sessionId, value.commandId, value.enqueueSequence ?? null, value.state,
          value.providerTurnId ?? null, value.startedAt ?? null, value.finishedAt ?? null,
          value.errorCode ?? null, revision, now, now,
        );
        return [{ kind: 'entity.upserted', payload: { entityType: 'turn', entityId: value.id } }];
      }
      case 'transcript.append':
        return this.appendTranscriptItems(database, mutation.items, now);
      case 'approval.upsert': {
        const value = mutation.value;
        const existing = database.prepare('SELECT state FROM approvals WHERE id = ?').get(value.id) as SqlRow | undefined;
        if (existing) {
          const state = requiredString(existing, 'state') as DaemonApproval['state'];
          if (state !== 'pending') {
            if (value.state === 'pending' || value.state === state) return [];
            throw new Error(`Approval ${value.id} cannot transition from ${state} to ${value.state}.`);
          }
        }
        database.prepare(`
          INSERT INTO approvals (
            id, session_id, turn_id, provider_request_id, risk, title, detail, state, resolved_at,
            revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            session_id = excluded.session_id, turn_id = excluded.turn_id, provider_request_id = excluded.provider_request_id,
            risk = excluded.risk, title = excluded.title, detail = excluded.detail, state = excluded.state,
            resolved_at = excluded.resolved_at, revision = excluded.revision, updated_at = excluded.updated_at
        `).run(
          value.id, value.sessionId, value.turnId ?? null, value.providerRequestId, value.risk, value.title,
          value.detail ?? null, value.state, value.resolvedAt ?? null, revision, now, now,
        );
        return [
          { kind: 'entity.upserted', payload: { entityType: 'approval', entityId: value.id } },
          { kind: 'approval.changed', payload: { approvalId: value.id, sessionId: value.sessionId } },
        ];
      }
      case 'provider.upsert': {
        const value = mutation.value;
        database.prepare(`
          INSERT INTO providers (
            id, display_name, protocol, executable_path, executable_version, argv_json,
            environment_variable_names_json, capabilities_json, review_digest, enabled, health, health_detail,
            revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            display_name = excluded.display_name, protocol = excluded.protocol, executable_path = excluded.executable_path,
            executable_version = excluded.executable_version, argv_json = excluded.argv_json,
            environment_variable_names_json = excluded.environment_variable_names_json,
            capabilities_json = excluded.capabilities_json,
            review_digest = COALESCE(excluded.review_digest, providers.review_digest),
            enabled = excluded.enabled, health = excluded.health,
            health_detail = excluded.health_detail, revision = excluded.revision, updated_at = excluded.updated_at
        `).run(
          value.id, value.displayName, value.protocol, value.executablePath, value.executableVersion,
          JSON.stringify(value.argv), JSON.stringify(value.environmentVariableNames), JSON.stringify(value.capabilities),
          value.reviewDigest ?? null, value.enabled ? 1 : 0, value.health, value.healthDetail ?? null, revision, now, now,
        );
        return [{ kind: 'entity.upserted', payload: { entityType: 'provider', entityId: value.id } }];
      }
      case 'schedule.upsert': {
        const value = mutation.value;
        database.prepare(`
          INSERT INTO schedules (
            id, name, workspace_id, provider_id, model, permission_preset, prompt, cron, timezone,
            enabled, max_runs, run_count, expires_at, next_run_at, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name, workspace_id = excluded.workspace_id, provider_id = excluded.provider_id,
            model = excluded.model, permission_preset = excluded.permission_preset, prompt = excluded.prompt,
            cron = excluded.cron, timezone = excluded.timezone, enabled = excluded.enabled,
            max_runs = excluded.max_runs, run_count = excluded.run_count, expires_at = excluded.expires_at,
            next_run_at = excluded.next_run_at, revision = excluded.revision, updated_at = excluded.updated_at
        `).run(
          value.id, value.name, value.workspaceId, value.providerId, value.model ?? null, value.permissionPreset,
          value.prompt, value.cron, value.timezone, value.enabled ? 1 : 0, value.maxRuns ?? null,
          value.runCount, value.expiresAt ?? null, value.nextRunAt ?? null, revision, now, now,
        );
        return [{ kind: 'entity.upserted', payload: { entityType: 'schedule', entityId: value.id } }];
      }
      case 'schedule.delete':
        database.prepare('DELETE FROM schedules WHERE id = ?').run(mutation.scheduleId);
        return [{ kind: 'entity.upserted', payload: { entityType: 'schedule', entityId: mutation.scheduleId } }];
      case 'schedule-run.upsert': {
        const value = mutation.value;
        database.prepare(`
          INSERT INTO schedule_runs (
            id, schedule_id, session_id, state, scheduled_for, started_at, finished_at,
            summary, error_code, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            schedule_id = excluded.schedule_id, session_id = excluded.session_id, state = excluded.state,
            scheduled_for = excluded.scheduled_for, started_at = excluded.started_at,
            finished_at = excluded.finished_at, summary = excluded.summary, error_code = excluded.error_code,
            revision = excluded.revision, updated_at = excluded.updated_at
        `).run(
          value.id, value.scheduleId, value.sessionId ?? null, value.state, value.scheduledFor,
          value.startedAt ?? null, value.finishedAt ?? null, value.summary ?? null, value.errorCode ?? null,
          revision, now, now,
        );
        // Schedule runs are internal dispatch records rather than snapshot
        // entities, but their transitions still advance the shared revision.
        // Emit continuity so subscribed clients never observe an unexplained
        // revision jump before their next command.
        return [{ kind: 'entity.upserted', payload: { entityType: 'schedule-run', entityId: value.id } }];
      }
      case 'heartbeat.upsert': {
        const value = mutation.value;
        database.prepare(`
          INSERT INTO heartbeats (
            session_id, prompt, cron, timezone, enabled, pending, next_run_at, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            prompt = excluded.prompt, cron = excluded.cron, timezone = excluded.timezone,
            enabled = excluded.enabled, pending = excluded.pending, next_run_at = excluded.next_run_at,
            revision = excluded.revision, updated_at = excluded.updated_at
        `).run(
          value.sessionId, value.prompt, value.cron, value.timezone, value.enabled ? 1 : 0,
          value.pending ? 1 : 0, value.nextRunAt ?? null, revision, now, now,
        );
        return [{ kind: 'entity.upserted', payload: { entityType: 'heartbeat', entityId: value.sessionId } }];
      }
      case 'heartbeat.delete':
        database.prepare('DELETE FROM heartbeats WHERE session_id = ?').run(mutation.sessionId);
        return [{ kind: 'entity.upserted', payload: { entityType: 'heartbeat', entityId: mutation.sessionId } }];
      case 'runtime.update': {
        const current = this.runtimeRow(database).settings;
        const next = { ...current, ...mutation.value };
        database.prepare(`
          UPDATE runtime_settings SET
            keep_running = ?, start_at_login = ?, orchestration_tools_enabled = ?, browser_enabled = ?,
            revision = ?, updated_at = ?
          WHERE singleton = 1
        `).run(
          next.keepRunning ? 1 : 0, next.startAtLogin ? 1 : 0,
          next.orchestrationToolsEnabled ? 1 : 0, next.browserEnabled ? 1 : 0,
          revision, now,
        );
        return [{ kind: 'runtime.changed', payload: { settings: next } }];
      }
      case 'migration-receipt.record': {
        const value = mutation.value;
        database.prepare(`
          INSERT INTO migration_receipts (id, source, fingerprint, detail_json, revision, imported_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(source, fingerprint) DO NOTHING
        `).run(value.id, value.source, value.fingerprint, value.detail === undefined ? null : JSON.stringify(value.detail), revision, now);
        return [];
      }
    }
  }

  private appendTranscriptItems(
    database: DatabaseSync,
    items: readonly DaemonTranscriptItemInput[],
    now: string,
  ): readonly DaemonEventDraft[] {
    if (items.length < 1 || items.length > this.maxTranscriptBatchItems) {
      throw new Error(`Transcript batch must contain between 1 and ${this.maxTranscriptBatchItems} items.`);
    }
    const byteLength = items.reduce((total, item) => total + Buffer.byteLength(item.text, 'utf8'), 0);
    if (byteLength > this.maxTranscriptBatchUtf8Bytes) {
      throw new Error(`Transcript batch exceeds ${this.maxTranscriptBatchUtf8Bytes} UTF-8 bytes.`);
    }
    const nextSequenceBySession = new Map<string, number>();
    const rangeBySession = new Map<string, { from: number; to: number }>();
    const insert = database.prepare(`
      INSERT INTO transcript_items (
        id, session_id, turn_id, sequence, kind, text, is_delta, is_sensitive, related_session_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const findExisting = database.prepare('SELECT id FROM transcript_items WHERE id = ?');
    for (const item of items) {
      // Provider history reconciliation is at-least-once. Stable item ids make
      // replay a no-op without consuming a new per-session sequence.
      if (findExisting.get(item.id)) continue;
      let previous = nextSequenceBySession.get(item.sessionId);
      if (previous === undefined) {
        const row = database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM transcript_items WHERE session_id = ?')
          .get(item.sessionId) as SqlRow;
        previous = integer(row, 'sequence');
      }
      const sequence = item.sequence ?? previous + 1;
      if (sequence !== previous + 1) {
        throw new Error(`Transcript sequence for ${item.sessionId} must be ${previous + 1}, received ${sequence}.`);
      }
      insert.run(
        item.id, item.sessionId, item.turnId ?? null, sequence, item.kind, item.text,
        item.isDelta ? 1 : 0, item.isSensitive ? 1 : 0, item.relatedSessionId ?? null, item.createdAt ?? now,
      );
      nextSequenceBySession.set(item.sessionId, sequence);
      const range = rangeBySession.get(item.sessionId);
      rangeBySession.set(item.sessionId, { from: range?.from ?? sequence, to: sequence });
    }
    return [...rangeBySession].map(([sessionId, range]) => ({
      kind: 'transcript.appended' as const,
      payload: { sessionId, fromSequence: range.from, toSequence: range.to },
    }));
  }

  private recoverUncertainCommandsInTransaction(database: DatabaseSync): readonly DaemonOutboxRecord[] {
    const rows = this.all(database, `
      SELECT * FROM command_outbox WHERE state IN ('pending', 'sent') ORDER BY created_at, command_id
    `);
    if (rows.length === 0) return [];
    const records = rows.map(outboxFromRow);
    this.markCommandsDeliveryUncertain(database, records, 'EZTerminal restarted before provider delivery was reconciled.');
    return records.map((record) => this.findCommandOrThrow(database, record.commandId));
  }

  private markCommandsDeliveryUncertain(
    database: DatabaseSync,
    records: readonly DaemonOutboxRecord[],
    detail: string,
  ): readonly DaemonCommandReceipt[] {
    if (records.length === 0) return [];
    const runtime = this.runtimeRow(database);
    const revision = runtime.revision + 1;
    const now = this.isoNow();
    database.exec('BEGIN IMMEDIATE');
    try {
      const drafts: DaemonEventDraft[] = [];
      const receipts: DaemonCommandReceipt[] = [];
      for (const record of records) {
        const sessionRows = this.all(database, `
          SELECT id, session_id FROM turns
          WHERE command_id = ? AND state IN ('queued', 'submitting', 'working', 'blocked')
        `, record.commandId);
        database.prepare(`
          UPDATE turns SET state = 'delivery-uncertain', error_code = 'delivery-uncertain', revision = ?, updated_at = ?
          WHERE command_id = ? AND state IN ('queued', 'submitting', 'working', 'blocked')
        `).run(revision, now, record.commandId);
        for (const row of sessionRows) {
          const turnId = requiredString(row, 'id');
          const sessionId = requiredString(row, 'session_id');
          database.prepare(`
            UPDATE sessions SET state = 'delivery-uncertain', revision = ?, updated_at = ?
            WHERE id = ? AND state NOT IN ('completed', 'interrupted', 'failed', 'archived')
          `).run(revision, now, sessionId);
          database.prepare(`
            UPDATE agents SET state = 'delivery-uncertain', revision = ?, updated_at = ?
            WHERE session_id = ? AND state NOT IN ('done', 'interrupted', 'error', 'archived')
          `).run(revision, now, sessionId);
          drafts.push(
            { kind: 'entity.upserted', payload: { entityType: 'turn', entityId: turnId } },
            { kind: 'entity.upserted', payload: { entityType: 'session', entityId: sessionId } },
            { kind: 'entity.upserted', payload: { entityType: 'agent', entityId: sessionId } },
          );
        }
        const receipt: DaemonCommandReceipt = {
          ok: false,
          status: 'delivery-uncertain',
          commandId: record.commandId,
          revision,
          error: { code: 'delivery-uncertain', message: detail, retryable: false },
        };
        receipts.push(receipt);
        database.prepare(`
          UPDATE command_outbox
          SET state = 'delivery-uncertain', receipt_json = ?, detail = ?, updated_at = ?, settled_at = ?
          WHERE command_id = ? AND state IN ('pending', 'sent')
        `).run(JSON.stringify(receipt), detail, now, now, record.commandId);
        drafts.push({ kind: 'command.changed', payload: { commandId: record.commandId, state: 'delivery-uncertain' } });
      }
      const eventSequence = this.appendEvents(database, drafts, revision, runtime.eventSequence, now);
      database.prepare('UPDATE runtime_settings SET revision = ?, event_sequence = ?, updated_at = ? WHERE singleton = 1')
        .run(revision, eventSequence, now);
      database.exec('COMMIT');
      return receipts;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}
