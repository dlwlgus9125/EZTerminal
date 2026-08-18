import { randomUUID } from 'node:crypto';

import type { AgentActivity, AgentActivitySnapshot, AgentFollowupResult, AgentState } from '../shared/agent';
import {
  EMPTY_AGENT_COORDINATION_SNAPSHOT,
  MAX_AGENT_PARTICIPANTS,
  type AgentCoordinationMutationResult,
  type AgentCoordinationSnapshot,
  type AgentParticipant,
  type AgentParticipantInput,
  type AgentProjectCoordination,
  type AgentProjectCoordinationInput,
  type AgentProjectRollup,
  type ManagedMergeRequest,
  withoutManagedMergeOutput,
} from '../shared/agent-coordination';
import type { PtyTextReadResult } from '../shared/ipc';
import type { AgentProjectRecord } from './agent-project-store';
import type { AgentCoordinationStore } from './agent-coordination-store';

export interface CoordinationActivitySource {
  getSnapshot(): AgentActivitySnapshot;
  onSnapshot(listener: (snapshot: AgentActivitySnapshot) => void): () => void;
  sendPrompt(
    activityId: string,
    text: string,
    options?: { readonly whenReady?: boolean },
  ): Promise<AgentFollowupResult>;
  readActivity(activityId: string, lines?: number): Promise<PtyTextReadResult>;
  markSeen(activityId: string, stateSeq: number): boolean;
}

export interface AgentWorkspaceIdentity {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly worktreeId?: string;
}

export interface CoordinationMergeSource {
  listRequests(): readonly ManagedMergeRequest[];
  onRequests(listener: () => void): () => void;
}

const EMPTY_COUNTS: Readonly<Record<AgentState, number>> = Object.freeze({
  starting: 0,
  working: 0,
  blocked: 0,
  done: 0,
  idle: 0,
  error: 0,
  unknown: 0,
});

function normalizedAlias(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function makeBrief(project: AgentProjectCoordination, participant: AgentParticipant): string {
  const validations = project.validationCommands.length > 0
    ? project.validationCommands.map((command) => `- ${command.name}: ${command.command}`).join('\n')
    : '- No managed validation commands are configured.';
  return [
    `You are ${participant.alias}, working as ${participant.role}.`,
    `Project goal: ${project.goal || 'No project goal has been set.'}`,
    `Your task: ${participant.task}`,
    `Default merge target: ${project.defaultTargetBranch}`,
    'Configured managed-merge validations:',
    validations,
    'Use ezterminal-agent list/read/prompt/wait to coordinate. Request a managed merge with:',
    `ezterminal-agent merge request --target ${project.defaultTargetBranch} --wait`,
  ].join('\n');
}

export class AgentCoordinationService {
  private readonly participantsByActivity = new Map<string, AgentParticipant>();
  private readonly listeners = new Set<(snapshot: AgentCoordinationSnapshot) => void>();
  private readonly unsubscribeActivity: () => void;
  private unsubscribeMerge: (() => void) | null = null;
  private mergeSource: CoordinationMergeSource | null = null;
  private revision = 0;
  private lastSnapshot = EMPTY_AGENT_COORDINATION_SNAPSHOT;

  constructor(private readonly deps: {
    readonly activities: CoordinationActivitySource;
    readonly store: AgentCoordinationStore;
    readonly listProjects: () => readonly AgentProjectRecord[];
    readonly resolveWorkspace: (activity: AgentActivity) => Promise<AgentWorkspaceIdentity | null>;
    readonly newId?: () => string;
    readonly now?: () => number;
  }) {
    this.unsubscribeActivity = deps.activities.onSnapshot((snapshot) => {
      const liveIds = new Set(snapshot.items.filter((item) => item.live).map((item) => item.id));
      let changed = false;
      for (const [activityId] of this.participantsByActivity) {
        if (liveIds.has(activityId)) continue;
        this.participantsByActivity.delete(activityId);
        changed = true;
      }
      this.publish(changed ? undefined : snapshot);
    });
    this.publish(deps.activities.getSnapshot());
  }

  bindMergeSource(source: CoordinationMergeSource): void {
    this.unsubscribeMerge?.();
    this.mergeSource = source;
    this.unsubscribeMerge = source.onRequests(() => this.publish());
    this.publish();
  }

  getSnapshot(): AgentCoordinationSnapshot {
    return this.lastSnapshot;
  }

  onSnapshot(listener: (snapshot: AgentCoordinationSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  resolveActivity(target: string): AgentActivity | null {
    const snapshot = this.lastSnapshot;
    const exact = snapshot.activities.find((activity) => activity.id === target);
    if (exact) return exact;
    const key = normalizedAlias(target);
    const matches = snapshot.activities.filter((activity) => (
      activity.participant && normalizedAlias(activity.participant.alias) === key
    ));
    return matches.length === 1 ? matches[0]! : null;
  }

  getParticipantByActivity(activityId: string): AgentParticipant | null {
    return this.participantsByActivity.get(activityId) ?? null;
  }

  getParticipant(participantId: string): AgentParticipant | null {
    return [...this.participantsByActivity.values()].find(
      (participant) => participant.participantId === participantId,
    ) ?? null;
  }

  getProject(projectId: string): AgentProjectCoordination | null {
    const project = this.deps.store.getProject(projectId);
    return project ? this.withParticipants(project) : null;
  }

  async join(
    input: AgentParticipantInput,
  ): Promise<AgentCoordinationMutationResult<{ readonly participant: AgentParticipant; readonly brief: string }>> {
    const activity = this.deps.activities.getSnapshot().items.find((item) => item.id === input.activityId);
    if (!activity || !activity.live || (activity.provider !== 'codex' && activity.provider !== 'claude')) {
      return { ok: false, error: 'not-found', message: 'Only a live Codex or Claude activity can join.' };
    }
    const alias = input.alias.trim();
    const role = input.role.trim();
    const task = input.task.trim();
    if (
      alias.length < 1 || alias.length > 48
      || role.length < 1 || role.length > 120
      || task.length < 1 || task.length > 1_000
    ) return { ok: false, error: 'invalid', message: 'Alias, role, or task is invalid.' };
    const workspace = await this.deps.resolveWorkspace(activity);
    if (!workspace) return { ok: false, error: 'not-found', message: 'The activity is outside a registered Project.' };
    const project = this.deps.store.getProject(workspace.projectId);
    if (!project) {
      return { ok: false, error: 'not-found', message: 'Configure the Project goal and target branch first.' };
    }
    if (
      input.expectedProjectRevision !== undefined
      && input.expectedProjectRevision !== project.configRevision
    ) return { ok: false, error: 'stale', message: 'Project configuration changed.' };
    const projectParticipants = [...this.participantsByActivity.values()].filter(
      (participant) => participant.projectId === workspace.projectId,
    );
    if (projectParticipants.length >= MAX_AGENT_PARTICIPANTS) {
      return { ok: false, error: 'unavailable', message: 'This Project has reached its participant limit.' };
    }
    if (projectParticipants.some((participant) => (
      participant.activityId !== activity.id && normalizedAlias(participant.alias) === normalizedAlias(alias)
    ))) return { ok: false, error: 'conflict', message: 'That alias is already in use in this Project.' };

    const now = (this.deps.now ?? Date.now)();
    const existing = this.participantsByActivity.get(activity.id);
    const participant: AgentParticipant = {
      participantId: existing?.participantId ?? (this.deps.newId ?? randomUUID)(),
      projectId: workspace.projectId,
      activityId: activity.id,
      sessionId: activity.sessionId,
      workspaceId: workspace.workspaceId,
      ...(workspace.worktreeId ? { worktreeId: workspace.worktreeId } : {}),
      alias,
      role,
      task,
      provider: activity.provider,
      joined: true,
      joinedAt: existing?.joinedAt ?? now,
      updatedAt: now,
    };
    this.participantsByActivity.set(activity.id, participant);
    this.publish();
    return { ok: true, value: { participant, brief: makeBrief(project, participant) } };
  }

  leave(activityId: string): boolean {
    const removed = this.participantsByActivity.delete(activityId);
    if (removed) this.publish();
    return removed;
  }

  async saveProject(
    input: AgentProjectCoordinationInput,
  ): Promise<AgentCoordinationMutationResult<AgentProjectCoordination>> {
    if (!this.deps.listProjects().some((project) => project.projectId === input.projectId)) {
      return { ok: false, error: 'not-found', message: 'Project not found.' };
    }
    const result = await this.deps.store.saveProject(input);
    if (!result.ok) {
      return {
        ok: false,
        error: result.reason,
        message: result.reason === 'stale' ? 'Project configuration changed.' : 'Invalid Project configuration.',
      };
    }
    this.publish();
    return { ok: true, value: this.withParticipants(result.project) };
  }

  markSeen(activityId: string, stateSeq: number): boolean {
    return this.deps.activities.markSeen(activityId, stateSeq);
  }

  read(target: string, lines = 80): Promise<PtyTextReadResult> {
    const activity = this.resolveActivity(target);
    return activity
      ? this.deps.activities.readActivity(activity.id, lines)
      : Promise.resolve({ ok: false, reason: 'run-not-found' });
  }

  prompt(target: string, text: string): Promise<AgentFollowupResult> {
    const activity = this.resolveActivity(target);
    return activity
      ? this.deps.activities.sendPrompt(activity.id, text)
      : Promise.resolve({ ok: false, error: 'not-found' });
  }

  waitFor(
    target: string,
    states: ReadonlySet<AgentState>,
    afterStateSeq: number | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<AgentActivity | null> {
    const initial = this.resolveActivity(target);
    if (!initial) return Promise.resolve(null);
    const matches = (activity: AgentActivity): boolean => (
      states.has(activity.state)
      && (afterStateSeq === undefined || activity.stateSeq > afterStateSeq)
    );
    if (matches(initial)) return Promise.resolve(initial);
    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe = (): void => undefined;
      const onAbort = (): void => finish(null);
      const finish = (activity: AgentActivity | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
        resolve(activity);
      };
      const timer = setTimeout(() => finish(null), Math.max(1, Math.min(30 * 60_000, timeoutMs)));
      timer.unref?.();
      unsubscribe = this.onSnapshot((snapshot) => {
        const activity = snapshot.activities.find((item) => item.id === initial.id);
        if (!activity || !activity.live) finish(activity ?? null);
        else if (matches(activity)) finish(activity);
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) finish(null);
    });
  }

  dispose(): void {
    this.unsubscribeActivity();
    this.unsubscribeMerge?.();
    this.listeners.clear();
    this.participantsByActivity.clear();
  }

  private withParticipants(project: AgentProjectCoordination): AgentProjectCoordination {
    return {
      ...project,
      participants: [...this.participantsByActivity.values()].filter(
        (participant) => participant.projectId === project.projectId,
      ),
    };
  }

  private publish(activitySnapshot = this.deps.activities.getSnapshot()): void {
    const participants = this.participantsByActivity;
    const activities = activitySnapshot.items.map((activity) => {
      const participant = participants.get(activity.id);
      return participant
        ? {
            ...activity,
            projectId: participant.projectId,
            workspaceId: participant.workspaceId,
            participant: {
              participantId: participant.participantId,
              projectId: participant.projectId,
              workspaceId: participant.workspaceId,
              ...(participant.worktreeId ? { worktreeId: participant.worktreeId } : {}),
              alias: participant.alias,
              role: participant.role,
              task: participant.task,
            },
          }
        : activity;
    });
    const requests = (this.mergeSource?.listRequests() ?? []).map(withoutManagedMergeOutput);
    const projects: AgentProjectRollup[] = this.deps.store.listProjects().map((stored) => {
      const project = this.withParticipants(stored);
      const counts = { ...EMPTY_COUNTS };
      for (const participant of project.participants) {
        const activity = activities.find((item) => item.id === participant.activityId);
        if (activity) counts[activity.state] += 1;
      }
      return {
        projectId: project.projectId,
        goal: project.goal,
        defaultTargetBranch: project.defaultTargetBranch,
        validationCommands: project.validationCommands,
        configRevision: project.configRevision,
        counts,
        participants: project.participants,
        pendingMergeCount: requests.filter((request) => (
          request.projectId === project.projectId
          && !['merged', 'denied', 'conflict', 'stale', 'failed', 'interrupted', 'already-integrated'].includes(request.state)
        )).length,
      };
    });
    this.revision += 1;
    this.lastSnapshot = {
      revision: this.revision,
      activityRevision: activitySnapshot.revision,
      activities,
      projects,
      mergeRequests: requests,
    };
    for (const listener of [...this.listeners]) {
      try {
        listener(this.lastSnapshot);
      } catch {
        // Observers consume committed level-triggered state.
      }
    }
  }
}
