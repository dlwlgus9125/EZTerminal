import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AgentParticipant, AgentProjectCoordination } from '../shared/agent-coordination';
import type { WorktreeInfo } from '../shared/worktree';
import type { AgentCoordinationService } from './agent-coordination-service';
import { AgentCoordinationStore } from './agent-coordination-store';
import type { AgentValidationRunner } from './agent-validation-runner';
import { ManagedMergeService, sameSecret } from './managed-merge-service';
import { SessionWorktreeGuard } from './session-worktree-guard';
import type { WorktreeService } from './worktree-service';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

interface MergeFixture {
  readonly root: string;
  readonly sourcePath: string;
  readonly userData: string;
  readonly participant: AgentParticipant;
  readonly source: WorktreeInfo;
  readonly store: AgentCoordinationStore;
  readonly service: ManagedMergeService;
}

async function createFixture(options: {
  readonly mutateCandidateDuringValidation?: boolean;
} = {}): Promise<MergeFixture> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ez-managed-merge-'));
  const repository = path.join(root, 'repository');
  const sourcePath = path.join(root, 'agent-source');
  const userData = path.join(root, 'user-data');
  execFileSync('git', ['init', '--initial-branch=main', repository]);
  git(repository, 'config', 'user.name', 'EZTerminal Test');
  git(repository, 'config', 'user.email', 'ezterminal@example.invalid');
  writeFileSync(path.join(repository, 'base.txt'), 'base\n', 'utf8');
  git(repository, 'add', 'base.txt');
  git(repository, 'commit', '-m', 'base');
  git(repository, 'worktree', 'add', '-b', 'agent/feature', sourcePath);
  writeFileSync(path.join(sourcePath, 'feature.txt'), 'agent change\n', 'utf8');
  git(sourcePath, 'add', 'feature.txt');
  git(sourcePath, 'commit', '-m', 'feature');

  const participant: AgentParticipant = {
    participantId: 'participant-1',
    projectId: 'project-1',
    activityId: 'activity-1',
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    worktreeId: 'worktree-1',
    alias: 'Builder',
    role: 'implementation',
    task: 'Build the feature',
    provider: 'codex',
    joined: true,
    joinedAt: 1,
    updatedAt: 1,
  };
  const source: WorktreeInfo = {
    worktreeId: 'worktree-1',
    repoId: 'repo-1',
    path: sourcePath,
    branch: 'agent/feature',
    head: git(sourcePath, 'rev-parse', 'HEAD'),
    main: false,
    locked: false,
    managed: true,
    prunable: false,
  };
  const project: AgentProjectCoordination = {
    projectId: 'project-1',
    goal: 'Safely merge the Agent work',
    defaultTargetBranch: 'main',
    validationCommands: [{
      id: 'unit',
      name: 'Unit tests',
      command: 'test-command',
      timeoutMs: 60_000,
    }],
    configRevision: 1,
    participants: [participant],
    updatedAt: 1,
  };
  const coordination = {
    getParticipantByActivity: vi.fn(() => participant),
    getParticipant: vi.fn(() => participant),
    getProject: vi.fn(() => project),
  };
  const worktrees = {
    execute: vi.fn(async () => ({ ok: true, action: 'list', worktrees: [source] } as const)),
  };
  const validationRunner = {
    run: vi.fn(async (
      _cwd: string,
      _command: string,
      _timeoutMs: number,
      _signal?: AbortSignal,
      onOutput?: (output: { readonly outputTail: string; readonly outputTruncated: boolean }) => void,
    ) => {
      onOutput?.({ outputTail: 'transient validation output', outputTruncated: false });
      if (options.mutateCandidateDuringValidation) {
        writeFileSync(path.join(_cwd, 'validation-mutation.txt'), 'not part of the candidate commit\n', 'utf8');
      }
      return {
        exitCode: 0,
        durationMs: 25,
        outputTail: 'transient validation output',
        outputTruncated: false,
        timedOut: false,
        cancelled: false,
      };
    }),
  };
  const store = new AgentCoordinationStore(userData);
  await store.init();
  let id = 0;
  let now = 1_000;
  const service = new ManagedMergeService({
    userDataDir: userData,
    coordination: coordination as unknown as AgentCoordinationService,
    coordinationStore: store,
    worktrees: worktrees as unknown as Pick<WorktreeService, 'execute'>,
    validationRunner: validationRunner as unknown as AgentValidationRunner,
    runGuard: new SessionWorktreeGuard(),
    projectRoot: () => repository,
    hasActiveRunInPath: async () => false,
    newId: () => `generated-${String(++id)}`,
    now: () => ++now,
  });
  await service.init();
  return { root, sourcePath, userData, participant, source, store, service };
}

async function waitForDecision(service: ManagedMergeService, requestId: string) {
  const request = await service.waitForRequest(requestId, undefined, 10_000, true);
  if (!request) throw new Error('managed merge did not reach a decision state');
  return request;
}

describe('ManagedMergeService', () => {
  it('builds and validates a detached candidate, then promotes only the approved immutable revision', async () => {
    const fixture = await createFixture();
    try {
      const mainBefore = git(path.join(fixture.root, 'repository'), 'rev-parse', 'main');
      const requested = await fixture.service.requestForActivity('activity-1', 'main');
      expect(requested.ok).toBe(true);
      if (!requested.ok) throw new Error(requested.message);

      const awaiting = await waitForDecision(fixture.service, requested.value.requestId);
      expect(awaiting).toMatchObject({
        state: 'approval-required',
        sourceHead: fixture.source.head,
        targetHead: mainBefore,
        validations: [{ status: 'passed', exitCode: 0 }],
      });
      expect(awaiting.candidateHead).toMatch(/^[0-9a-f]{40,64}$/u);
      expect(git(path.join(fixture.root, 'repository'), 'rev-parse', 'main')).toBe(mainBefore);
      await expect(fixture.service.readCandidateDiff(awaiting.requestId, awaiting.revision)).resolves.toMatchObject({
        ok: true,
        text: expect.stringContaining('feature.txt'),
      });
      await expect(fixture.service.readCandidateDiff(awaiting.requestId, awaiting.revision - 1)).resolves.toEqual({
        ok: false,
        error: 'git-failed',
      });

      const approved = await fixture.service.decide({
        requestId: awaiting.requestId,
        revision: awaiting.revision,
        decision: 'approve',
        actor: 'desktop',
      });
      expect(approved).toMatchObject({ ok: true, value: { state: 'merged' } });
      if (!approved.ok) throw new Error(approved.message);
      expect(git(path.join(fixture.root, 'repository'), 'rev-parse', 'main')).toBe(approved.value.candidateHead);
      expect(git(path.join(fixture.root, 'repository'), 'show', 'main:feature.txt')).toBe('agent change');

      const audit = fixture.store.listAudit('project-1');
      expect(audit).toMatchObject([{
        requestId: awaiting.requestId,
        decisionActor: 'desktop',
        outcome: 'merged',
        validations: [{ status: 'passed', digest: expect.stringMatching(/^[0-9a-f]{64}$/u) }],
      }]);
      expect(JSON.stringify(audit)).not.toContain('transient validation output');
      expect(git(path.join(fixture.root, 'repository'), 'for-each-ref', '--format=%(refname)', 'refs/ezterminal')).toBe('');
    } finally {
      await fixture.service.dispose();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('allows an exact one-shot grant to auto-promote one validated request', async () => {
    const fixture = await createFixture();
    try {
      expect(fixture.service.grantNext({
        participantId: fixture.participant.participantId,
        sourceWorkspaceId: fixture.participant.workspaceId,
        targetBranch: 'other',
        durationMs: 123 as 900000,
      })).toMatchObject({ ok: false, error: 'invalid' });
      expect(fixture.service.grantNext({
        participantId: fixture.participant.participantId,
        sourceWorkspaceId: fixture.participant.workspaceId,
        targetBranch: 'main',
        durationMs: 900000,
      })).toMatchObject({ ok: true });

      const requested = await fixture.service.requestForActivity('activity-1', 'main');
      if (!requested.ok) throw new Error(requested.message);
      const merged = await waitForDecision(fixture.service, requested.value.requestId);
      expect(merged.state).toBe('merged');
      expect(fixture.store.listAudit('project-1')).toMatchObject([{
        requestId: merged.requestId,
        decisionActor: 'grant',
        outcome: 'merged',
      }]);
    } finally {
      await fixture.service.dispose();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects a validation that changes the immutable candidate worktree', async () => {
    const fixture = await createFixture({ mutateCandidateDuringValidation: true });
    try {
      const mainBefore = git(path.join(fixture.root, 'repository'), 'rev-parse', 'main');
      const requested = await fixture.service.requestForActivity('activity-1', 'main');
      if (!requested.ok) throw new Error(requested.message);

      const failed = await waitForDecision(fixture.service, requested.value.requestId);
      expect(failed).toMatchObject({
        state: 'failed',
        error: 'A validation command changed the immutable merge candidate.',
      });
      await fixture.service.dispose();
      expect(git(path.join(fixture.root, 'repository'), 'rev-parse', 'main')).toBe(mainBefore);
      expect(fixture.store.listAudit('project-1')).toMatchObject([{
        requestId: failed.requestId,
        outcome: 'failed',
      }]);
      expect(git(path.join(fixture.root, 'repository'), 'for-each-ref', '--format=%(refname)', 'refs/ezterminal')).toBe('');
    } finally {
      await fixture.service.dispose();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('compares capability secrets without exposing prefix timing behavior', () => {
    expect(sameSecret('same-value', 'same-value')).toBe(true);
    expect(sameSecret('same-value', 'same-valuE')).toBe(false);
    expect(sameSecret('short', 'a much longer value')).toBe(false);
  });
});
