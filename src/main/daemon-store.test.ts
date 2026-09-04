import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  createDaemonCommand,
  type DaemonCommandEnvelope,
  type DaemonCommandPayloads,
  type DaemonCommandType,
} from '../shared/daemon-protocol';
import {
  DAEMON_DATABASE_FILE_NAME,
  DAEMON_DATABASE_SCHEMA_VERSION,
  DaemonStore,
  resolveDaemonDatabasePath,
  type DaemonStoreMutation,
} from './daemon-store';
import {
  DAEMON_MIGRATION_BACKUP_DIRECTORY_NAME,
  DAEMON_QUARANTINE_DIRECTORY_NAME,
  DAEMON_RECOVERY_DIRECTORY_NAME,
  DaemonStoreRecovery,
} from './daemon-store-recovery';

const FIXED_TIME = '2026-09-04T02:00:00.000Z';

function makeDirectory(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ezterminal-daemon-store-'));
}

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function sqliteMaterialSnapshot(directory: string): readonly {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}[] {
  return [
    DAEMON_DATABASE_FILE_NAME,
    `${DAEMON_DATABASE_FILE_NAME}-wal`,
    `${DAEMON_DATABASE_FILE_NAME}-shm`,
  ].filter((name) => existsSync(path.join(directory, name))).map((name) => {
    const filePath = path.join(directory, name);
    const stats = statSync(filePath);
    return { name, size: stats.size, mtimeMs: stats.mtimeMs, sha256: sha256(filePath) };
  });
}

function recoverySets(directory: string, category: string): readonly string[] {
  const root = path.join(directory, DAEMON_RECOVERY_DIRECTORY_NAME, category);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => !name.startsWith('.'))
    .sort()
    .map((name) => path.join(root, name));
}

interface TestRecoveryManifest {
  readonly kind: string;
  readonly schemaVersion: number | null;
  readonly files: readonly {
    readonly name: string;
    readonly size: number;
    readonly mtimeMs: number;
    readonly sha256: string;
  }[];
}

function recoveryManifest(setPath: string): TestRecoveryManifest {
  return JSON.parse(readFileSync(path.join(setPath, 'manifest.json'), 'utf8')) as TestRecoveryManifest;
}

function command<T extends DaemonCommandType>(
  type: T,
  payload: DaemonCommandPayloads[T],
  options: { readonly id?: string; readonly key?: string; readonly revision?: number } = {},
): DaemonCommandEnvelope<T> {
  const id = options.id ?? `command-${type}`;
  return createDaemonCommand<T>({
    commandId: id,
    idempotencyKey: options.key ?? `key-${id}`,
    expectedRevision: options.revision ?? 0,
    issuedAt: FIXED_TIME,
    principal: { kind: 'desktop', id: 'desktop-test' },
    type,
    payload,
  });
}

function projectMutation(id = 'project-1'): DaemonStoreMutation {
  return {
    kind: 'project.upsert',
    value: { id, name: 'EZTerminal', rootPath: 'C:\\Working\\EZTerminal', source: 'native' },
  };
}

function workspaceMutation(id = 'workspace-1', projectId = 'project-1'): DaemonStoreMutation {
  return {
    kind: 'workspace.upsert',
    value: {
      id,
      projectId,
      name: 'Local',
      kind: 'local',
      rootPath: 'C:\\Working\\EZTerminal',
    },
  };
}

function sessionMutation(
  id = 'session-1',
  kind: 'agent' | 'terminal' = 'agent',
  state: 'idle' | 'running' | 'delivery-uncertain' = kind === 'agent' ? 'idle' : 'running',
): DaemonStoreMutation {
  return {
    kind: 'session.upsert',
    value: {
      id,
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      kind,
      title: id,
      state,
      source: 'structured',
    },
  };
}

function providerMutation(): DaemonStoreMutation {
  return {
    kind: 'provider.upsert',
    value: {
      id: 'codex',
      displayName: 'Codex',
      protocol: 'codex-app-server',
      executablePath: 'C:\\Tools\\codex.exe',
      executableVersion: '0.152.1',
      argv: ['app-server'],
      environmentVariableNames: ['CODEX_HOME'],
      capabilities: ['streaming', 'approvals'],
      reviewDigest: 'a'.repeat(64),
      enabled: true,
      health: 'ready',
    },
  };
}

describe('DaemonStore', () => {
  it('creates the complete versioned WAL schema with foreign keys enabled', async () => {
    const directory = makeDirectory();
    expect(resolveDaemonDatabasePath(directory)).toBe(path.join(directory, DAEMON_DATABASE_FILE_NAME));
    expect(() => resolveDaemonDatabasePath('relative/path')).toThrow(/absolute/);
    expect(() => resolveDaemonDatabasePath(path.parse(directory).root)).toThrow(/filesystem root/);

    const store = new DaemonStore(directory, { now: () => new Date(FIXED_TIME) });
    await store.init();
    expect(store.getDiagnostics()).toEqual({
      databasePath: path.join(directory, DAEMON_DATABASE_FILE_NAME),
      schemaVersion: DAEMON_DATABASE_SCHEMA_VERSION,
      journalMode: 'wal',
      foreignKeys: true,
    });
    expect(store.getSnapshot()).toMatchObject({
      protocolVersion: 12,
      revision: 0,
      eventSequence: 0,
      generatedAt: FIXED_TIME,
      runtime: {
        keepRunning: false,
        startAtLogin: false,
        orchestrationToolsEnabled: false,
        browserEnabled: false,
      },
      projects: [],
      workspaces: [],
      sessions: [],
    });
    await store.close();

    const database = new DatabaseSync(path.join(directory, DAEMON_DATABASE_FILE_NAME));
    const tableRows = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(tableRows.map((row) => row.name)).toEqual([
      'agent_relations',
      'agents',
      'approvals',
      'command_outbox',
      'heartbeats',
      'migration_receipts',
      'projects',
      'providers',
      'revisioned_events',
      'runtime_settings',
      'schedule_runs',
      'schedules',
      'sessions',
      'transcript_items',
      'turns',
      'workspaces',
    ]);
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
    expect(database.prepare("SELECT name FROM pragma_table_info('providers') WHERE name = 'review_digest'").get())
      .toEqual({ name: 'review_digest' });
    expect(database.prepare("SELECT name FROM pragma_table_info('turns') WHERE name = 'enqueue_sequence'").get())
      .toEqual({ name: 'enqueue_sequence' });
    expect(database.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    database.close();
  });

  it('rolls back a mutation that violates a foreign key', async () => {
    const store = new DaemonStore(makeDirectory());
    await store.init();
    await expect(store.applySystemCommit({ mutations: [workspaceMutation('workspace-orphan', 'missing-project')] }))
      .rejects.toThrow(/FOREIGN KEY/);
    expect(store.getRevision()).toBe(0);
    expect(store.getSnapshot().workspaces).toEqual([]);
    await store.close();
  });

  it('persists a write-ahead command once and replays its receipt by idempotency key', async () => {
    const store = new DaemonStore(makeDirectory(), { now: () => new Date(FIXED_TIME) });
    await store.init();
    const create = command('project.create', { projectId: 'project-1', name: 'EZTerminal' }, { id: 'create-project' });
    expect(await store.beginOutbox(create)).toMatchObject({ state: 'pending', commandId: 'create-project' });

    const duplicate = command(
      'project.create',
      { projectId: 'other-project', name: 'Ignored duplicate' },
      { id: 'different-command', key: create.idempotencyKey },
    );
    expect(await store.beginOutbox(duplicate)).toMatchObject({
      state: 'pending',
      commandId: 'create-project',
      command: { payload: { projectId: 'project-1' } },
    });
    expect(await store.markOutboxSent(create.commandId)).toMatchObject({ state: 'sent', sentAt: FIXED_TIME });

    const applied = await store.commitCommand(create.commandId, { mutations: [projectMutation()] });
    expect(applied).toEqual({
      ok: true,
      status: 'applied',
      commandId: 'create-project',
      revision: 1,
      eventSequence: 2,
    });
    expect(store.findCommandByIdempotencyKey(create.idempotencyKey)).toMatchObject({ state: 'applied', receipt: applied });
    await expect(store.commitCommand(create.commandId)).resolves.toMatchObject({ ok: true, status: 'replayed', revision: 1 });
    expect(store.getRevision()).toBe(1);

    const stale = command('project.create', { projectId: 'project-2', name: 'Stale' }, { id: 'stale', revision: 0 });
    expect(await store.beginOutbox(stale)).toMatchObject({
      state: 'failed',
      receipt: { ok: false, error: { code: 'revision-conflict', currentRevision: 1 } },
    });
    await store.close();
  });

  it('builds an authoritative snapshot and strictly monotonic event stream in one transaction', async () => {
    let eventId = 0;
    const store = new DaemonStore(makeDirectory(), {
      now: () => new Date(FIXED_TIME),
      idFactory: () => `event-${++eventId}`,
    });
    await store.init();
    const create = command(
      'agent.create',
      {
        sessionId: 'session-child',
        workspaceId: 'workspace-1',
        title: 'Child',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Implement the store',
        parentSessionId: 'session-parent',
      },
      { id: 'agent-create' },
    );
    await store.beginOutbox(create);
    const receipt = await store.commitCommand(create.commandId, {
      mutations: [
        projectMutation(),
        workspaceMutation(),
        providerMutation(),
        sessionMutation('session-parent'),
        sessionMutation('session-child'),
        {
          kind: 'agent.upsert',
          value: {
            sessionId: 'session-parent',
            providerId: 'codex',
            model: 'gpt-5.6',
            permissionPreset: 'full-access',
            state: 'working',
            currentTurnId: 'turn-1',
            queuedTurnCount: 0,
            orchestrationEnabled: true,
          },
        },
        {
          kind: 'agent.upsert',
          value: {
            sessionId: 'session-child',
            providerId: 'codex',
            permissionPreset: 'standard',
            state: 'idle',
            queuedTurnCount: 1,
            orchestrationEnabled: true,
          },
        },
        {
          kind: 'agent-relation.upsert',
          value: {
            id: 'relation-1',
            treeId: 'tree-1',
            parentSessionId: 'session-parent',
            childSessionId: 'session-child',
            owner: 'managed',
            depth: 1,
          },
        },
        {
          kind: 'turn.upsert',
          value: {
            id: 'turn-1',
            sessionId: 'session-parent',
            commandId: create.commandId,
            state: 'working',
            startedAt: FIXED_TIME,
          },
        },
        {
          kind: 'transcript.append',
          items: [
            {
              id: 'transcript-1',
              sessionId: 'session-parent',
              turnId: 'turn-1',
              kind: 'user-message',
              text: 'Build it',
              isDelta: false,
              isSensitive: false,
            },
            {
              id: 'transcript-2',
              sessionId: 'session-parent',
              turnId: 'turn-1',
              kind: 'assistant-message',
              text: 'Working',
              isDelta: true,
              isSensitive: false,
              relatedSessionId: 'session-child',
            },
          ],
        },
        {
          kind: 'approval.upsert',
          value: {
            id: 'approval-1',
            sessionId: 'session-parent',
            turnId: 'turn-1',
            providerRequestId: 'provider-request-1',
            risk: 'write',
            title: 'Write daemon state',
            state: 'pending',
          },
        },
        {
          kind: 'schedule.upsert',
          value: {
            id: 'schedule-1',
            name: 'Nightly review',
            workspaceId: 'workspace-1',
            providerId: 'codex',
            permissionPreset: 'plan',
            prompt: 'Review changes',
            cron: '0 2 * * *',
            timezone: 'Asia/Seoul',
            enabled: true,
            runCount: 0,
          },
        },
        {
          kind: 'heartbeat.upsert',
          value: {
            sessionId: 'session-parent',
            prompt: 'Check status',
            cron: '*/15 * * * *',
            timezone: 'Asia/Seoul',
            enabled: true,
            pending: false,
          },
        },
        {
          kind: 'runtime.update',
          value: { keepRunning: true, startAtLogin: true, orchestrationToolsEnabled: true },
        },
      ],
      events: [{ kind: 'runtime.recovery', payload: { mode: 'normal' } }],
    });
    expect(receipt).toMatchObject({ ok: true, revision: 1 });

    const snapshot = store.getSnapshot();
    expect(snapshot).toMatchObject({
      revision: 1,
      eventSequence: receipt.ok ? receipt.eventSequence : -1,
      runtime: { keepRunning: true, startAtLogin: true, orchestrationToolsEnabled: true, browserEnabled: false },
      projects: [{ id: 'project-1', revision: 1 }],
      workspaces: [{ id: 'workspace-1', projectId: 'project-1', revision: 1 }],
      sessions: [{ id: 'session-child' }, { id: 'session-parent' }],
      agents: [
        { sessionId: 'session-child', queuedTurnCount: 1, state: 'idle' },
        { sessionId: 'session-parent', currentTurnId: 'turn-1', state: 'working' },
      ],
      agentRelations: [{ id: 'relation-1', depth: 1 }],
      turns: [{ id: 'turn-1', commandId: 'agent-create' }],
      transcriptHeads: [{ sessionId: 'session-parent', lastSequence: 2, itemCount: 2 }],
      approvals: [{ id: 'approval-1', state: 'pending' }],
      providers: [{
        id: 'codex',
        argv: ['app-server'],
        environmentVariableNames: ['CODEX_HOME'],
        reviewDigest: 'a'.repeat(64),
      }],
      schedules: [{ id: 'schedule-1', cron: '0 2 * * *' }],
      heartbeats: [{ sessionId: 'session-parent', pending: false }],
    });
    expect(store.getTranscript('session-parent')).toMatchObject([
      { id: 'transcript-1', sequence: 1, text: 'Build it' },
      { id: 'transcript-2', sequence: 2, text: 'Working', relatedSessionId: 'session-child' },
    ]);
    const events = store.listEventsAfter(0);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
    expect(events.every((event) => event.revision === 1)).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'command.changed', payload: { commandId: 'agent-create', state: 'applied' } });

    const appended = await store.appendTranscriptBatch([{
      id: 'transcript-3',
      sessionId: 'session-parent',
      kind: 'assistant-message',
      text: 'Done',
      isDelta: false,
      isSensitive: false,
    }]);
    expect(appended).toEqual({ revision: 2, eventSequence: snapshot.eventSequence + 1 });
    expect(store.listEventsAfter(snapshot.eventSequence)).toMatchObject([{
      sequence: snapshot.eventSequence + 1,
      revision: 2,
      kind: 'transcript.appended',
      payload: { fromSequence: 3, toSequence: 3 },
    }]);
    await store.close();
  });

  it('bounds transcript batches by count, bytes, and contiguous authoritative sequence', async () => {
    const store = new DaemonStore(makeDirectory(), {
      maxTranscriptBatchItems: 2,
      maxTranscriptBatchUtf8Bytes: 8,
    });
    await store.init();
    await store.applySystemCommit({ mutations: [projectMutation(), workspaceMutation(), sessionMutation('terminal-1', 'terminal')] });
    const item = (id: string, text: string, sequence?: number) => ({
      id,
      sessionId: 'terminal-1',
      kind: 'notice' as const,
      text,
      isDelta: true,
      isSensitive: false,
      ...(sequence === undefined ? {} : { sequence }),
    });
    await expect(store.appendTranscriptBatch([item('one', '1'), item('two', '2'), item('three', '3')]))
      .rejects.toThrow(/between 1 and 2/);
    await expect(store.appendTranscriptBatch([item('large', '123456789')])).rejects.toThrow(/UTF-8 bytes/);
    await expect(store.appendTranscriptBatch([item('gap', 'ok', 2)])).rejects.toThrow(/must be 1/);
    expect(store.getRevision()).toBe(1);
    expect(store.getTranscript('terminal-1')).toEqual([]);
    await expect(store.appendTranscriptBatch([item('one', '1'), item('two', '2')])).resolves.toMatchObject({ revision: 2 });
    expect(store.getTranscript('terminal-1').map((entry) => entry.sequence)).toEqual([1, 2]);
    await store.close();
  });

  it('makes stable transcript ids idempotent without consuming sequence numbers', async () => {
    const store = new DaemonStore(makeDirectory());
    await store.init();
    await store.applySystemCommit({
      mutations: [projectMutation(), workspaceMutation(), sessionMutation('terminal-1', 'terminal')],
    });
    const replayed = {
      id: 'stable-provider-item',
      sessionId: 'terminal-1',
      sequence: 1,
      kind: 'assistant-message' as const,
      text: 'Recovered once.',
      isDelta: false,
      isSensitive: false,
    };

    await store.appendTranscriptBatch([replayed]);
    await store.appendTranscriptBatch([replayed]);
    await store.appendTranscriptBatch([{
      ...replayed,
      id: 'next-provider-item',
      sequence: 2,
      text: 'Still contiguous.',
    }]);

    expect(store.getTranscript('terminal-1')).toMatchObject([
      { id: 'stable-provider-item', sequence: 1 },
      { id: 'next-provider-item', sequence: 2 },
    ]);
    await store.close();
  });

  it('keeps approval decisions monotonic across duplicate and conflicting provider events', async () => {
    const store = new DaemonStore(makeDirectory());
    await store.init();
    await store.applySystemCommit({
      mutations: [projectMutation(), workspaceMutation(), sessionMutation()],
    });
    const pending: DaemonStoreMutation = {
      kind: 'approval.upsert',
      value: {
        id: 'approval-stable',
        sessionId: 'session-1',
        providerRequestId: 'provider-request',
        risk: 'write',
        title: 'Write file',
        state: 'pending',
      },
    };
    await store.applySystemCommit({ mutations: [pending] });
    await store.applySystemCommit({ mutations: [{
      kind: 'approval.upsert',
      value: { ...pending.value, state: 'allowed', resolvedAt: FIXED_TIME },
    }] });
    await store.applySystemCommit({ mutations: [pending] });

    expect(store.getSnapshot().approvals).toEqual([
      expect.objectContaining({ id: 'approval-stable', state: 'allowed', resolvedAt: FIXED_TIME }),
    ]);
    const revision = store.getRevision();
    await expect(store.applySystemCommit({ mutations: [{
      kind: 'approval.upsert',
      value: { ...pending.value, state: 'denied', resolvedAt: FIXED_TIME },
    }] })).rejects.toThrow(/cannot transition from allowed to denied/);
    expect(store.getRevision()).toBe(revision);
    await store.close();
  });

  it('serializes competing commits so only the command with the current revision applies', async () => {
    const store = new DaemonStore(makeDirectory());
    await store.init();
    const first = command('project.create', { projectId: 'project-1', name: 'One' }, { id: 'first' });
    const second = command('project.create', { projectId: 'project-2', name: 'Two' }, { id: 'second' });
    await Promise.all([store.beginOutbox(first), store.beginOutbox(second)]);
    const [firstReceipt, secondReceipt] = await Promise.all([
      store.commitCommand(first.commandId, { mutations: [projectMutation('project-1')] }),
      store.commitCommand(second.commandId, { mutations: [projectMutation('project-2')] }),
    ]);
    expect(firstReceipt).toMatchObject({ ok: true, revision: 1 });
    expect(secondReceipt).toMatchObject({ ok: false, error: { code: 'revision-conflict', currentRevision: 1 } });
    expect(store.getSnapshot().projects.map((project) => project.id)).toEqual(['project-1']);
    await store.close();
  });

  it('recovers both pending and sent commands as delivery-uncertain without retrying them', async () => {
    const directory = makeDirectory();
    const first = new DaemonStore(directory);
    await first.init();
    const pending = command('agent.submit', { sessionId: 'agent-1', prompt: 'pending' }, { id: 'pending' });
    const sent = command('agent.submit', { sessionId: 'agent-1', prompt: 'sent' }, { id: 'sent' });
    await first.beginOutbox(pending);
    await first.beginOutbox(sent);
    await first.markOutboxSent(sent.commandId);
    await first.close();

    const restarted = new DaemonStore(directory);
    await restarted.init();
    expect(restarted.getRevision()).toBe(1);
    expect(restarted.findCommand('pending')).toMatchObject({
      state: 'delivery-uncertain',
      receipt: { ok: false, status: 'delivery-uncertain', error: { retryable: false } },
    });
    expect(restarted.findCommand('sent')).toMatchObject({ state: 'delivery-uncertain' });
    expect(restarted.listEventsAfter(0).map((event) => event.payload)).toEqual([
      { commandId: 'pending', state: 'delivery-uncertain' },
      { commandId: 'sent', state: 'delivery-uncertain' },
    ]);
    await restarted.close();

    const restartedAgain = new DaemonStore(directory);
    await restartedAgain.init();
    expect(restartedAgain.getRevision()).toBe(1);
    expect(await restartedAgain.recoverUncertainCommands()).toEqual([]);
    await restartedAgain.close();
  });

  it('settles a recovered outbox command only through explicit reconciliation', async () => {
    const directory = makeDirectory();
    const first = new DaemonStore(directory);
    await first.init();
    const pending = command('agent.submit', {
      sessionId: 'agent-1',
      prompt: 'Maybe delivered',
    }, { id: 'reconcile-me' });
    await first.beginOutbox(pending);
    await first.close();

    const restarted = new DaemonStore(directory);
    await restarted.init();
    expect(restarted.findCommand(pending.commandId)?.state).toBe('delivery-uncertain');
    const transition = await restarted.applySystemCommit({
      reconciledCommands: [{ commandId: pending.commandId, state: 'applied' }],
    });

    expect(restarted.findCommand(pending.commandId)).toMatchObject({
      state: 'applied',
      receipt: {
        ok: true,
        status: 'applied',
        revision: transition.revision,
        eventSequence: transition.eventSequence,
      },
    });
    expect(restarted.listEventsAfter(0).at(-1)).toMatchObject({
      kind: 'command.changed',
      payload: { commandId: pending.commandId, state: 'applied' },
    });
    await restarted.close();
  });

  it('marks linked turn, session, and agent state uncertain during crash recovery', async () => {
    const directory = makeDirectory();
    const first = new DaemonStore(directory);
    await first.init();
    const submit = command('agent.submit', { sessionId: 'session-1', prompt: 'Do work' }, { id: 'submit' });
    await first.beginOutbox(submit);
    await first.applySystemCommit({
      mutations: [
        projectMutation(), workspaceMutation(), providerMutation(), sessionMutation(),
        {
          kind: 'agent.upsert',
          value: {
            sessionId: 'session-1', providerId: 'codex', permissionPreset: 'standard',
            state: 'working', currentTurnId: 'turn-1', queuedTurnCount: 0, orchestrationEnabled: true,
          },
        },
        {
          kind: 'turn.upsert',
          value: { id: 'turn-1', sessionId: 'session-1', commandId: 'submit', state: 'working' },
        },
      ],
    });
    await first.markOutboxSent('submit');
    await first.close();

    const restarted = new DaemonStore(directory);
    await restarted.init();
    expect(restarted.getSnapshot()).toMatchObject({
      revision: 2,
      sessions: [{ id: 'session-1', state: 'delivery-uncertain', revision: 2 }],
      agents: [{ sessionId: 'session-1', state: 'delivery-uncertain', revision: 2 }],
      turns: [{ id: 'turn-1', state: 'delivery-uncertain', errorCode: 'delivery-uncertain', revision: 2 }],
    });
    await restarted.close();
  });

  it('does not resurrect a terminal turn while recovering an unsettled outbox command', async () => {
    const directory = makeDirectory();
    const first = new DaemonStore(directory);
    await first.init();
    const submit = command('agent.submit', { sessionId: 'session-1', prompt: 'Already finished' }, { id: 'finished-submit' });
    await first.beginOutbox(submit);
    await first.applySystemCommit({ mutations: [
      projectMutation(),
      workspaceMutation(),
      providerMutation(),
      {
        kind: 'session.upsert',
        value: {
          id: 'session-1',
          projectId: 'project-1',
          workspaceId: 'workspace-1',
          kind: 'agent',
          title: 'Finished',
          state: 'interrupted',
          source: 'structured',
        },
      },
      {
        kind: 'agent.upsert',
        value: {
          sessionId: 'session-1',
          providerId: 'codex',
          permissionPreset: 'standard',
          state: 'interrupted',
          queuedTurnCount: 0,
          orchestrationEnabled: false,
        },
      },
      {
        kind: 'turn.upsert',
        value: {
          id: 'turn-finished',
          sessionId: 'session-1',
          commandId: submit.commandId,
          state: 'interrupted',
          finishedAt: FIXED_TIME,
        },
      },
    ] });
    await first.markOutboxSent(submit.commandId);
    await first.close();

    const restarted = new DaemonStore(directory);
    await restarted.init();
    expect(restarted.findCommand(submit.commandId)?.state).toBe('delivery-uncertain');
    expect(restarted.getSnapshot()).toMatchObject({
      sessions: [{ id: 'session-1', state: 'interrupted' }],
      agents: [{ sessionId: 'session-1', state: 'interrupted' }],
      turns: [{ id: 'turn-finished', state: 'interrupted' }],
    });
    await restarted.close();
  });

  it('records migration receipts idempotently and refuses a newer database schema', async () => {
    const directory = makeDirectory();
    const store = new DaemonStore(directory);
    await store.init();
    await store.applySystemCommit({
      mutations: [
        { kind: 'migration-receipt.record', value: { id: 'receipt-1', source: 'legacy-json', fingerprint: 'sha256:one' } },
        { kind: 'migration-receipt.record', value: { id: 'receipt-2', source: 'legacy-json', fingerprint: 'sha256:one' } },
      ],
    });
    await store.close();
    const database = new DatabaseSync(path.join(directory, DAEMON_DATABASE_FILE_NAME));
    expect(database.prepare('SELECT COUNT(*) AS count FROM migration_receipts').get()).toEqual({ count: 1 });
    database.exec('PRAGMA user_version = 999');
    const databasePath = path.join(directory, DAEMON_DATABASE_FILE_NAME);
    const beforeMaterial = sqliteMaterialSnapshot(directory);
    expect(beforeMaterial.map((file) => file.name)).toEqual([
      DAEMON_DATABASE_FILE_NAME,
      `${DAEMON_DATABASE_FILE_NAME}-wal`,
      `${DAEMON_DATABASE_FILE_NAME}-shm`,
    ]);
    const recoveryEntriesBefore = existsSync(path.join(directory, DAEMON_RECOVERY_DIRECTORY_NAME))
      ? readdirSync(path.join(directory, DAEMON_RECOVERY_DIRECTORY_NAME), { recursive: true }).sort()
      : [];

    const newer = new DaemonStore(directory);
    await expect(newer.init()).rejects.toMatchObject({
      code: 'future-schema',
      databaseDisposition: 'preserved',
      schemaVersion: 999,
    });
    expect(sqliteMaterialSnapshot(directory)).toEqual(beforeMaterial);
    expect(existsSync(databasePath)).toBe(true);
    expect(
      existsSync(path.join(directory, DAEMON_RECOVERY_DIRECTORY_NAME))
        ? readdirSync(path.join(directory, DAEMON_RECOVERY_DIRECTORY_NAME), { recursive: true }).sort()
        : [],
    ).toEqual(recoveryEntriesBefore);
    database.close();
  });

  it('migrates a version-one turn queue and backfills a durable FIFO sequence', async () => {
    const directory = makeDirectory();
    const initial = new DaemonStore(directory);
    await initial.init();
    const create = command('agent.create', {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      title: 'Queued Agent',
      providerId: 'codex',
      permissionPreset: 'standard',
      initialPrompt: 'Queue me',
    }, { id: 'queued-agent' });
    await initial.beginOutbox(create);
    await initial.commitCommand(create.commandId, {
      mutations: [
        projectMutation(),
        workspaceMutation(),
        providerMutation(),
        sessionMutation(),
        {
          kind: 'turn.upsert',
          value: {
            id: 'turn-v1',
            sessionId: 'session-1',
            commandId: create.commandId,
            enqueueSequence: 99,
            state: 'queued',
          },
        },
      ],
    });
    await initial.close();

    const database = new DatabaseSync(path.join(directory, DAEMON_DATABASE_FILE_NAME));
    database.exec(`
      DROP INDEX turns_fifo_queue;
      DROP INDEX transcript_items_turn_kind;
      ALTER TABLE turns DROP COLUMN enqueue_sequence;
      UPDATE providers SET review_digest = NULL;
      PRAGMA user_version = 1;
    `);
    database.close();
    const preMigrationHash = sha256(path.join(directory, DAEMON_DATABASE_FILE_NAME));

    const migrated = new DaemonStore(directory);
    await migrated.init();
    expect(migrated.getDiagnostics().schemaVersion).toBe(3);
    expect(migrated.getSnapshot().turns).toEqual([
      expect.objectContaining({ id: 'turn-v1', enqueueSequence: expect.any(Number) }),
    ]);
    expect(migrated.getSnapshot().providers).toEqual([
      expect.objectContaining({
        id: 'codex',
        enabled: true,
        health: 'unknown',
        healthDetail: 'Provider executable review must be renewed before launch.',
      }),
    ]);
    const backups = recoverySets(directory, DAEMON_MIGRATION_BACKUP_DIRECTORY_NAME);
    expect(backups).toHaveLength(1);
    const manifest = recoveryManifest(backups[0]!);
    expect(manifest).toMatchObject({ kind: 'pre-migration-backup', schemaVersion: 1 });
    expect(manifest.files).toEqual([
      expect.objectContaining({
        name: DAEMON_DATABASE_FILE_NAME,
        sha256: preMigrationHash,
        size: expect.any(Number),
        mtimeMs: expect.any(Number),
      }),
    ]);
    expect(sha256(path.join(backups[0]!, 'material', DAEMON_DATABASE_FILE_NAME))).toBe(preMigrationHash);
    await migrated.close();
  });

  it('copies only bounded SQLite material into verified, non-overwriting backup sets', async () => {
    const directory = makeDirectory();
    const databasePath = path.join(directory, DAEMON_DATABASE_FILE_NAME);
    const sourceFiles = [
      [DAEMON_DATABASE_FILE_NAME, 'database-bytes'],
      [`${DAEMON_DATABASE_FILE_NAME}-wal`, 'wal-bytes'],
      [`${DAEMON_DATABASE_FILE_NAME}-shm`, 'shm-bytes'],
    ] as const;
    for (const [name, contents] of sourceFiles) writeFileSync(path.join(directory, name), contents);
    const recovery = new DaemonStoreRecovery(directory, databasePath, {
      now: () => new Date(FIXED_TIME),
      recoveryIdFactory: () => 'stable-recovery',
    });
    recovery.prepareUserDataDirectory();

    const first = await recovery.createMigrationBackup(1);
    const firstManifestBytes = readFileSync(path.join(first.path, 'manifest.json'), 'utf8');
    expect(first.manifest.files.map((file) => file.name)).toEqual(sourceFiles.map(([name]) => name).sort());
    for (const [name] of sourceFiles) {
      const source = path.join(directory, name);
      const copied = path.join(first.path, 'material', name);
      const manifestFile = first.manifest.files.find((file) => file.name === name);
      expect(manifestFile).toMatchObject({ size: readFileSync(source).byteLength, sha256: sha256(source) });
      expect(sha256(copied)).toBe(sha256(source));
    }

    const second = await recovery.createMigrationBackup(1);
    expect(second.path).not.toBe(first.path);
    expect(path.basename(second.path)).toMatch(/-2$/u);
    expect(readFileSync(path.join(first.path, 'manifest.json'), 'utf8')).toBe(firstManifestBytes);
    expect(recoverySets(directory, DAEMON_MIGRATION_BACKUP_DIRECTORY_NAME)).toHaveLength(2);

    const quarantine = await recovery.quarantine(1);
    expect(quarantine.manifest.files.map((file) => file.name)).toEqual(sourceFiles.map(([name]) => name).sort());
    for (const [name] of sourceFiles) {
      expect(existsSync(path.join(directory, name))).toBe(false);
      expect(sha256(path.join(quarantine.path, 'material', name)))
        .toBe(sha256(path.join(quarantine.path, 'snapshot', name)));
    }
  });

  it('backs up the exact legacy JSON allowlist before first DB creation and skips backup on current-schema restart', async () => {
    const directory = makeDirectory();
    const legacySources = [
      ['layout.json', '{"layout":true}'],
      ['layout.json.tmp', 'pending-layout'],
      ['agent-projects.json.corrupt', 'prior-project-evidence'],
      ['agent-coordination.json.tmp', 'pending-coordination'],
      ['agent-team-catalog.json', '{"teams":[]}'],
    ] as const;
    for (const [name, contents] of legacySources) writeFileSync(path.join(directory, name), contents);
    writeFileSync(path.join(directory, 'remote-token.json'), 'must-not-be-copied');

    const initial = new DaemonStore(directory, {
      now: () => new Date(FIXED_TIME),
      recoveryIdFactory: () => 'legacy-review',
    });
    await initial.init();
    await initial.close();

    const backups = recoverySets(directory, DAEMON_MIGRATION_BACKUP_DIRECTORY_NAME);
    expect(backups).toHaveLength(1);
    const manifest = recoveryManifest(backups[0]!);
    expect(manifest.kind).toBe('initial-legacy-backup');
    expect(manifest.files.map((file) => file.name)).toEqual(legacySources.map(([name]) => name).sort());
    for (const [name, contents] of legacySources) {
      expect(readFileSync(path.join(directory, name), 'utf8')).toBe(contents);
      expect(readFileSync(path.join(backups[0]!, 'material', name), 'utf8')).toBe(contents);
    }
    expect(existsSync(path.join(backups[0]!, 'material', 'remote-token.json'))).toBe(false);

    const restarted = new DaemonStore(directory, {
      now: () => new Date(FIXED_TIME),
      recoveryIdFactory: () => 'legacy-review',
    });
    await restarted.init();
    await restarted.close();
    expect(recoverySets(directory, DAEMON_MIGRATION_BACKUP_DIRECTORY_NAME)).toEqual(backups);
  });

  it('quarantines corrupt DB material with a verified snapshot and rejects initialization', async () => {
    const directory = makeDirectory();
    const databasePath = path.join(directory, DAEMON_DATABASE_FILE_NAME);
    writeFileSync(databasePath, 'not-a-sqlite-database');
    const corruptHash = sha256(databasePath);
    const store = new DaemonStore(directory, {
      now: () => new Date(FIXED_TIME),
      recoveryIdFactory: () => 'corrupt-db',
    });

    let latchedFailure: unknown;
    try {
      await store.init();
    } catch (error) {
      latchedFailure = error;
    }
    expect(latchedFailure).toMatchObject({
      code: 'database-corrupt',
      safeMode: 'legacy-only',
      databaseDisposition: 'quarantined',
    });
    await expect(store.init()).rejects.toBe(latchedFailure);
    expect(existsSync(databasePath)).toBe(false);
    const quarantines = recoverySets(directory, DAEMON_QUARANTINE_DIRECTORY_NAME);
    expect(quarantines).toHaveLength(1);
    const manifest = recoveryManifest(quarantines[0]!);
    expect(manifest.files).toEqual([
      expect.objectContaining({ name: DAEMON_DATABASE_FILE_NAME, sha256: corruptHash }),
    ]);
    expect(sha256(path.join(quarantines[0]!, 'snapshot', DAEMON_DATABASE_FILE_NAME))).toBe(corruptHash);
    expect(sha256(path.join(quarantines[0]!, 'material', DAEMON_DATABASE_FILE_NAME))).toBe(corruptHash);

    const firstManifest = readFileSync(path.join(quarantines[0]!, 'manifest.json'), 'utf8');
    writeFileSync(databasePath, 'a-second-corrupt-database');
    const retry = new DaemonStore(directory, {
      now: () => new Date(FIXED_TIME),
      recoveryIdFactory: () => 'corrupt-db',
    });
    await expect(retry.init()).rejects.toMatchObject({
      code: 'database-corrupt',
      databaseDisposition: 'quarantined',
    });
    const retriedQuarantines = recoverySets(directory, DAEMON_QUARANTINE_DIRECTORY_NAME);
    expect(retriedQuarantines).toHaveLength(2);
    expect(path.basename(retriedQuarantines[1]!)).toMatch(/-2$/u);
    expect(readFileSync(path.join(retriedQuarantines[0]!, 'manifest.json'), 'utf8')).toBe(firstManifest);
  });

  it('backs up then quarantines a structurally invalid legacy schema after migration failure', async () => {
    const directory = makeDirectory();
    const databasePath = path.join(directory, DAEMON_DATABASE_FILE_NAME);
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE runtime_settings (singleton INTEGER PRIMARY KEY); PRAGMA user_version = 1;');
    database.close();
    const preMigrationHash = sha256(databasePath);
    const store = new DaemonStore(directory, {
      now: () => new Date(FIXED_TIME),
      recoveryIdFactory: () => 'failed-migration',
    });

    await expect(store.init()).rejects.toMatchObject({
      code: 'migration-failed',
      databaseDisposition: 'quarantined',
      schemaVersion: 1,
    });
    expect(existsSync(databasePath)).toBe(false);
    const backups = recoverySets(directory, DAEMON_MIGRATION_BACKUP_DIRECTORY_NAME);
    const quarantines = recoverySets(directory, DAEMON_QUARANTINE_DIRECTORY_NAME);
    expect(backups).toHaveLength(1);
    expect(quarantines).toHaveLength(1);
    expect(recoveryManifest(backups[0]!).files).toEqual([
      expect.objectContaining({ name: DAEMON_DATABASE_FILE_NAME, sha256: preMigrationHash }),
    ]);
    expect(recoveryManifest(quarantines[0]!).files.map((file) => file.name)).toEqual([
      DAEMON_DATABASE_FILE_NAME,
    ]);
  });

  it('quarantines only material actually created by a failed fresh initialization', async () => {
    const directory = makeDirectory();
    let clockCalls = 0;
    const store = new DaemonStore(directory, {
      now: () => {
        clockCalls += 1;
        return clockCalls === 1 ? new Date(Number.NaN) : new Date(FIXED_TIME);
      },
      recoveryIdFactory: () => 'fresh-failure',
    });

    await expect(store.init()).rejects.toMatchObject({
      code: 'initialization-failed',
      databaseDisposition: 'quarantined',
    });
    expect(existsSync(path.join(directory, DAEMON_DATABASE_FILE_NAME))).toBe(false);
    const quarantines = recoverySets(directory, DAEMON_QUARANTINE_DIRECTORY_NAME);
    expect(quarantines).toHaveLength(1);
    expect(recoveryManifest(quarantines[0]!).files.map((file) => file.name)).toEqual([
      DAEMON_DATABASE_FILE_NAME,
    ]);
  });

  it('fails closed when the recovery root is a symlink or Windows reparse junction', async () => {
    const directory = makeDirectory();
    const outside = makeDirectory();
    const databasePath = path.join(directory, DAEMON_DATABASE_FILE_NAME);
    writeFileSync(databasePath, 'preserve-me');
    const beforeHash = sha256(databasePath);
    const recovery = new DaemonStoreRecovery(directory, databasePath, {
      now: () => new Date(FIXED_TIME),
      recoveryIdFactory: () => 'linked-root',
    });
    recovery.prepareUserDataDirectory();
    symlinkSync(
      outside,
      path.join(directory, DAEMON_RECOVERY_DIRECTORY_NAME),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(recovery.createMigrationBackup(1)).rejects.toMatchObject({ operation: 'backup' });
    expect(sha256(databasePath)).toBe(beforeHash);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('closes deterministically and rejects use after close', async () => {
    const store = new DaemonStore(makeDirectory());
    await store.init();
    await store.flush();
    await store.close();
    await store.close();
    expect(() => store.getSnapshot()).toThrow(/not open/);
    await expect(store.applySystemCommit({ mutations: [projectMutation()] })).rejects.toThrow(/not open/);
  });
});
