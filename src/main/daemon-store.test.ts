import { mkdtempSync } from 'node:fs';
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

const FIXED_TIME = '2026-09-04T02:00:00.000Z';

function makeDirectory(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ezterminal-daemon-store-'));
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
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
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
      providers: [{ id: 'codex', argv: ['app-server'], environmentVariableNames: ['CODEX_HOME'] }],
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
    database.close();

    const newer = new DaemonStore(directory);
    await expect(newer.init()).rejects.toThrow(/newer than supported/);
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
