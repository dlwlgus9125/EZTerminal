import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AGENT_COORDINATION_SCHEMA_VERSION,
  type ManagedMergeAuditRecord,
} from '../shared/agent-coordination';
import { AgentCoordinationStore } from './agent-coordination-store';

const makeDir = (): string => mkdtempSync(path.join(os.tmpdir(), 'ez-agent-coordination-'));

const validation = {
  id: 'unit',
  name: 'Unit tests',
  command: 'pnpm test:unit',
  timeoutMs: 60_000,
} as const;

function auditRecord(): ManagedMergeAuditRecord {
  return {
    auditId: 'audit-1',
    requestId: 'request-1',
    projectId: 'project-1',
    participantId: 'participant-1',
    sourceWorkspaceId: 'workspace-1',
    sourceBranch: 'agent/feature',
    sourceHead: '1'.repeat(40),
    targetBranch: 'main',
    targetHead: '2'.repeat(40),
    candidateHead: '3'.repeat(40),
    validations: [{
      name: 'Unit tests',
      status: 'passed',
      durationMs: 120,
      exitCode: 0,
      digest: 'a'.repeat(64),
    }],
    decisionActor: 'desktop',
    outcome: 'merged',
    createdAt: 10,
    finishedAt: 20,
  };
}

describe('AgentCoordinationStore', () => {
  it('persists revisioned Project configuration and rejects stale writers', async () => {
    const directory = makeDir();
    const store = new AgentCoordinationStore(directory);
    await store.init();

    const created = await store.saveProject({
      projectId: 'project-1',
      goal: '  Ship the collaboration flow  ',
      defaultTargetBranch: 'main',
      validationCommands: [validation],
      expectedRevision: 0,
    });
    expect(created).toMatchObject({
      ok: true,
      project: { goal: 'Ship the collaboration flow', configRevision: 1 },
    });
    await expect(store.saveProject({
      projectId: 'project-1',
      goal: 'Overwrite stale state',
      defaultTargetBranch: 'main',
      validationCommands: [],
      expectedRevision: 0,
    })).resolves.toEqual({ ok: false, reason: 'stale' });

    const reloaded = new AgentCoordinationStore(directory);
    await reloaded.init();
    expect(reloaded.getProject('project-1')).toMatchObject({
      goal: 'Ship the collaboration flow',
      configRevision: 1,
      validationCommands: [validation],
      participants: [],
    });
  });

  it('removes only Project configuration while preserving managed-merge audit evidence', async () => {
    const directory = makeDir();
    const store = new AgentCoordinationStore(directory);
    await store.init();
    await store.saveProject({
      projectId: 'project-1',
      goal: 'Ship the collaboration flow',
      defaultTargetBranch: 'main',
      validationCommands: [validation],
    });
    await store.appendAudit(auditRecord());

    await expect(store.removeProject('project-1')).resolves.toBe(true);
    await expect(store.removeProject('project-1')).resolves.toBe(false);
    expect(store.getProject('project-1')).toBeNull();
    expect(store.listAudit('project-1')).toEqual([auditRecord()]);

    const reloaded = new AgentCoordinationStore(directory);
    await reloaded.init();
    expect(reloaded.getProject('project-1')).toBeNull();
    expect(reloaded.listAudit('project-1')).toEqual([auditRecord()]);
  });

  it('rejects unsafe local branch names and duplicate validation ids', async () => {
    const store = new AgentCoordinationStore(makeDir());
    await store.init();
    for (const branch of ['-force', 'refs/heads/main.lock', 'feature..main', 'topic@{1}', '.hidden']) {
      await expect(store.saveProject({
        projectId: 'project-1',
        goal: 'Goal',
        defaultTargetBranch: branch,
        validationCommands: [],
      })).resolves.toEqual({ ok: false, reason: 'invalid' });
    }
    await expect(store.saveProject({
      projectId: 'project-1',
      goal: 'Goal',
      defaultTargetBranch: 'main',
      validationCommands: [validation, { ...validation, name: 'Duplicate' }],
    })).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('never persists transient output or unknown audit fields', async () => {
    const directory = makeDir();
    const store = new AgentCoordinationStore(directory);
    await store.init();
    const unsafeRuntimeRecord = {
      ...auditRecord(),
      outputTail: 'SECRET TOP LEVEL',
      validations: [{
        ...auditRecord().validations[0],
        outputTail: 'SECRET VALIDATION OUTPUT',
      }],
    } as unknown as ManagedMergeAuditRecord;

    await store.appendAudit(unsafeRuntimeRecord);
    await store.flush();

    const persisted = readFileSync(path.join(directory, 'agent-coordination.json'), 'utf8');
    expect(persisted).not.toContain('SECRET');
    expect(store.listAudit()).toEqual([auditRecord()]);
  });

  it('quarantines a structurally invalid current-version file', async () => {
    const directory = makeDir();
    const file = path.join(directory, 'agent-coordination.json');
    writeFileSync(file, JSON.stringify({
      version: AGENT_COORDINATION_SCHEMA_VERSION,
      projects: [{
        projectId: 'project-1',
        goal: '',
        defaultTargetBranch: 'main',
        validationCommands: [],
        configRevision: 1,
        updatedAt: 10,
      }],
      audit: [],
    }), 'utf8');

    const store = new AgentCoordinationStore(directory);
    await store.init();

    expect(store.listProjects()).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.corrupt`)).toBe(true);
  });
});
