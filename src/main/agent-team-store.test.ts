import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AgentTeamRun } from '../shared/agent-team';
import { AgentTeamStore } from './agent-team-store';

const makeDir = (): string => mkdtempSync(path.join(os.tmpdir(), 'ez-agent-teams-'));

async function savedPersona(store: AgentTeamStore, name: string, provider: 'codex' | 'claude') {
  const result = await store.savePersona({
    name,
    icon: provider === 'codex' ? 'code' : 'bot',
    role: `${name} role`,
    instructions: `${name} instructions`,
    launch: provider === 'codex'
      ? { provider, sandbox: 'workspace-write' }
      : { provider, permissionMode: 'acceptEdits', effort: 'high' },
  });
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

describe('AgentTeamStore', () => {
  it('persists capability-safe Personas and a referentially valid Team', async () => {
    const dir = makeDir();
    const store = new AgentTeamStore(dir);
    await store.init();
    const planner = await savedPersona(store, 'Planner', 'codex');
    const implementer = await savedPersona(store, 'Implementer', 'claude');
    const team = await store.saveTeam({
      name: 'Core team',
      description: 'Two local coding agents',
      instructions: 'Keep changes reviewable.',
      defaultGoal: {
        outcome: 'Ship one reviewable change',
        acceptanceCriteria: ['The configured validation passes.'],
      },
      personaIds: [planner.personaId, implementer.personaId],
      plannerPersonaId: planner.personaId,
    });
    expect(team.ok).toBe(true);

    const reloaded = new AgentTeamStore(dir);
    await reloaded.init();
    expect(reloaded.listPersonas()).toHaveLength(2);
    expect(reloaded.listTeams()).toEqual([expect.objectContaining({
      name: 'Core team',
      defaultGoal: {
        outcome: 'Ship one reviewable change',
        acceptanceCriteria: ['The configured validation passes.'],
      },
    })]);
  });

  it('creates the complete starter catalog in one revision and never adds a partial starter', async () => {
    const dir = makeDir();
    const store = new AgentTeamStore(dir);
    await store.init();

    const created = await store.createStarterTeam({
      plannerProvider: 'codex',
      implementerProvider: 'claude',
    });
    expect(created).toMatchObject({
      ok: true,
      value: {
        planner: { name: 'Planner', preset: 'planner', launch: { provider: 'codex', sandbox: 'read-only' } },
        implementer: { name: 'Implementer', preset: 'implementer', launch: { provider: 'claude', permissionMode: 'acceptEdits' } },
        team: { name: 'Starter team' },
      },
    });
    expect(store.catalogRevision).toBe(1);
    expect(store.listPersonas()).toHaveLength(2);
    expect(store.listTeams()).toHaveLength(1);
    await expect(store.createStarterTeam({
      plannerProvider: 'codex',
      implementerProvider: 'claude',
    })).resolves.toMatchObject({ ok: false, error: 'conflict' });
    expect(store.catalogRevision).toBe(1);

    const reloaded = new AgentTeamStore(dir);
    await reloaded.init();
    expect(reloaded.listPersonas()).toHaveLength(2);
    expect(reloaded.listTeams()[0]?.personaIds).toEqual(reloaded.listPersonas().map((persona) => persona.personaId));
  });

  it('rejects stale writes and deletion of a referenced Persona', async () => {
    const store = new AgentTeamStore(makeDir());
    await store.init();
    const planner = await savedPersona(store, 'Planner', 'codex');
    const worker = await savedPersona(store, 'Worker', 'claude');
    await store.saveTeam({
      name: 'Team',
      instructions: 'Coordinate.',
      personaIds: [planner.personaId, worker.personaId],
      plannerPersonaId: planner.personaId,
    });

    await expect(store.deletePersona(planner.personaId, planner.revision)).resolves.toMatchObject({
      ok: false,
      error: 'conflict',
    });
    await expect(store.savePersona({
      personaId: worker.personaId,
      expectedRevision: worker.revision + 1,
      name: worker.name,
      icon: worker.icon,
      role: worker.role,
      instructions: worker.instructions,
      launch: worker.launch,
    })).resolves.toMatchObject({ ok: false, error: 'stale' });
  });

  it('keeps a run snapshot independent from later catalog edits', async () => {
    const dir = makeDir();
    const store = new AgentTeamStore(dir);
    await store.init();
    const planner = await savedPersona(store, 'Planner', 'codex');
    const worker = await savedPersona(store, 'Worker', 'claude');
    const teamResult = await store.saveTeam({
      name: 'Team',
      instructions: 'Original instructions.',
      personaIds: [planner.personaId, worker.personaId],
      plannerPersonaId: planner.personaId,
    });
    if (!teamResult.ok) throw new Error(teamResult.message);
    const now = Date.now();
    const run: AgentTeamRun = {
      schemaVersion: 1,
      runId: crypto.randomUUID(),
      revision: 1,
      projectId: 'project-1',
      projectName: 'Project',
      goal: 'Ship the feature',
      targetBranch: 'main',
      validationConfigRevision: 1,
      validationCommands: [],
      team: teamResult.value,
      personas: [planner, worker],
      plannerPersonaId: planner.personaId,
      phase: 'preparing-planner',
      slots: [planner, worker].map((persona) => ({
        personaId: persona.personaId,
        state: 'planned' as const,
        updatedAt: now,
      })),
      warningAcknowledged: true,
      createdAt: now,
      updatedAt: now,
    };
    await expect(store.saveRun(run)).resolves.toMatchObject({ ok: true });
    const concurrent = await Promise.all([
      store.saveRun({ ...run, revision: 2, message: 'first update', updatedAt: now + 1 }),
      store.saveRun({ ...run, revision: 2, message: 'stale update', updatedAt: now + 1 }),
    ]);
    expect(concurrent.filter((result) => result.ok)).toHaveLength(1);
    expect(concurrent.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ error: 'stale' }),
    ]);
    await store.saveTeam({
      teamId: teamResult.value.teamId,
      expectedRevision: teamResult.value.revision,
      name: teamResult.value.name,
      instructions: 'Changed later.',
      personaIds: teamResult.value.personaIds,
      plannerPersonaId: teamResult.value.plannerPersonaId,
    });
    expect(store.getRun(run.runId)?.team.instructions).toBe('Original instructions.');

    const restarted = new AgentTeamStore(dir);
    await restarted.init();
    expect(restarted.getRun(run.runId)).toMatchObject({
      phase: 'failed',
      message: 'EZTerminal stopped before this Team run finished.',
      slots: [
        expect.objectContaining({ state: 'failed' }),
        expect.objectContaining({ state: 'failed' }),
      ],
    });
  });
});
