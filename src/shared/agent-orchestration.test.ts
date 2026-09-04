import { describe, expect, it } from 'vitest';

import {
  AGENT_ORCHESTRATION_SCHEMA_VERSION,
  CollaborationRunSchema,
  composeWorkerBrief,
  normalizeWriteScope,
  orchestrationWorkerActivityIds,
  writeScopesOverlap,
  type CollaborationRun,
  type CollaborationTask,
} from './agent-orchestration';

describe('agent orchestration contract', () => {
  it('normalizes project-relative scopes and rejects escaping or Windows-special paths', () => {
    expect(normalizeWriteScope('./src//renderer/')).toBe('src/renderer/');
    expect(normalizeWriteScope('.')).toBe('.');
    expect(normalizeWriteScope('')).toBeNull();
    expect(normalizeWriteScope('../secret')).toBeNull();
    expect(normalizeWriteScope('C:\\secret')).toBeNull();
    expect(normalizeWriteScope('src:stream')).toBeNull();
    expect(normalizeWriteScope('src/line\nbreak')).toBeNull();
    expect(normalizeWriteScope('src/CON')).toBeNull();
    expect(normalizeWriteScope('src/trailing.')).toBeNull();
  });

  it('detects parent/child scope overlap without treating siblings as overlapping', () => {
    expect(writeScopesOverlap(['src/'], ['src/renderer/'])).toBe(true);
    expect(writeScopesOverlap(['src/main/'], ['src/renderer/'])).toBe(false);
    expect(writeScopesOverlap(['.'], ['docs/'])).toBe(true);
  });

  it('identifies worker activities without classifying the Lead activity', () => {
    expect([...orchestrationWorkerActivityIds({
      runs: [{
        schemaVersion: AGENT_ORCHESTRATION_SCHEMA_VERSION,
        runId: 'run-1', revision: 1, projectId: 'project-1',
        leadSessionId: 'lead-session', leadActivityId: 'lead-activity', policyRevision: 1,
        state: 'active', createdAt: 1, updatedAt: 1, expiresAt: 60_001,
        tasks: [{
          taskId: 'task-1', revision: 1, title: 'Worker', brief: 'Do bounded work.',
          mode: 'read-only', dependsOn: [], writeScopes: [], profileId: 'builtin:codex:read',
          state: 'working', createdAt: 1, updatedAt: 1,
          worker: {
            workerId: 'worker-1', taskId: 'task-1', profileId: 'builtin:codex:read',
            providerId: 'codex', sessionId: 'worker-session', activityId: 'worker-activity',
          },
        }],
      }],
    })]).toEqual(['worker-activity']);
  });

  it('puts the depth limit, exact scope, and structured report command in worker briefs', () => {
    const now = 10;
    const task: CollaborationTask = {
      taskId: 'task-1', revision: 1, title: 'Implement UI', brief: 'Change only the requested surface.',
      mode: 'write', dependsOn: [], writeScopes: ['src/renderer/'], profileId: 'builtin:codex:write',
      state: 'queued', createdAt: now, updatedAt: now,
    };
    const run: CollaborationRun = {
      schemaVersion: AGENT_ORCHESTRATION_SCHEMA_VERSION, runId: 'run-1', revision: 1,
      projectId: 'project-1', leadSessionId: 'lead-1', leadActivityId: 'activity-1',
      policyRevision: 1, state: 'active', tasks: [task], createdAt: now, updatedAt: now,
      expiresAt: now + 60_000,
    };
    const brief = composeWorkerBrief(run, task, []);
    expect(brief).toContain('depth-1 worker');
    expect(brief).toContain('src/renderer/');
    expect(brief).toContain('do not create subagents');
    expect(brief).toContain('ezterminal-agent worker report task-1');
    expect(CollaborationRunSchema.safeParse(run).success).toBe(true);
  });
});
