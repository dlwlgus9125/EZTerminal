import { Bot, CornerDownRight } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import {
  classifyDaemonEvent,
  type DaemonAgent,
  type DaemonAgentRelation,
  type DaemonEvent,
  type DaemonSession,
  type DaemonSnapshot,
} from '../shared/daemon-protocol';
import {
  rendererCapabilities,
  type DaemonAccess,
} from './capability-access';
import { useAppTranslation } from './i18n';
import { Button } from './ui';
import './daemon-agent-sessions.css';

export type DaemonAgentSessionListAccess = Pick<DaemonAccess, 'getSnapshot' | 'observeEvents'>;

export interface DaemonAgentSessionOpenInput {
  readonly sessionId: string;
  readonly title?: string;
  readonly providerLabel?: string;
}

export interface DaemonAgentSessionsProps {
  readonly onOpenSession: (input: DaemonAgentSessionOpenInput) => void;
  readonly access?: DaemonAgentSessionListAccess;
}

interface SessionNode {
  readonly session: DaemonSession;
  readonly agent: DaemonAgent;
  readonly providerLabel: string;
  readonly workspaceLabel: string;
  readonly relation?: DaemonAgentRelation;
  readonly parentTitle?: string;
  readonly children: readonly SessionNode[];
}

interface WorkspaceGroup {
  readonly id: string;
  readonly label: string;
  readonly kind: 'local' | 'worktree';
  readonly path: string;
  readonly sessions: readonly SessionNode[];
}

interface ProjectGroup {
  readonly id: string;
  readonly label: string;
  readonly workspaces: readonly WorkspaceGroup[];
}

const STATE_RANK: Readonly<Record<DaemonAgent['state'], number>> = {
  blocked: 0,
  'delivery-uncertain': 1,
  error: 2,
  starting: 3,
  working: 4,
  queued: 5,
  idle: 6,
  interrupted: 7,
  done: 8,
  archived: 9,
};

const PROJECTION_ENTITY_TYPES = new Set([
  'project',
  'workspace',
  'session',
  'agent',
  'relation',
  'provider',
]);

/** Events whose payload can change the Project → Workspace → Session list. */
export function daemonEventAffectsAgentSessionProjection(event: DaemonEvent): boolean {
  if (event.kind === 'entity.upserted') {
    return PROJECTION_ENTITY_TYPES.has(event.payload.entityType);
  }
  return event.kind === 'entity.archived' || event.kind === 'runtime.recovery';
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareNodes(left: Omit<SessionNode, 'children'>, right: Omit<SessionNode, 'children'>): number {
  return STATE_RANK[left.agent.state] - STATE_RANK[right.agent.state]
    || timestamp(right.session.updatedAt) - timestamp(left.session.updatedAt)
    || left.session.title.localeCompare(right.session.title)
    || left.session.id.localeCompare(right.session.id);
}

/**
 * Builds the compact daemon projection without inventing a second session
 * authority. Same-workspace children stay under their parent. Cross-workspace
 * managed children remain discoverable in their owning Workspace and carry
 * parent provenance. Provider-native children always stay below their parent,
 * so they cannot be mistaken for an independently managed top-level session.
 */
export function projectDaemonAgentSessions(snapshot: DaemonSnapshot): readonly ProjectGroup[] {
  const providers = new Map(snapshot.providers.map((provider) => [provider.id, provider.displayName]));
  const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
  const workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
  const agents = new Map(snapshot.agents.map((agent) => [agent.sessionId, agent]));
  const sessions = new Map<string, Omit<SessionNode, 'children'>>();

  for (const session of snapshot.sessions) {
    if (
      session.kind !== 'agent'
      || session.source !== 'structured'
      || session.archivedAt !== undefined
      || session.state === 'archived'
    ) continue;
    const agent = agents.get(session.id);
    if (!agent || agent.state === 'archived') continue;
    const workspace = workspaces.get(session.workspaceId);
    sessions.set(session.id, {
      session,
      agent,
      providerLabel: providers.get(agent.providerId) ?? agent.providerId,
      workspaceLabel: workspace?.name ?? session.workspaceId,
    });
  }

  const relationByChild = new Map<string, DaemonAgentRelation>();
  const childRelations = new Map<string, DaemonAgentRelation[]>();
  for (const relation of snapshot.agentRelations) {
    if (relation.detachedAt !== undefined || !sessions.has(relation.childSessionId)) continue;
    const current = relationByChild.get(relation.childSessionId);
    if (!current || relation.depth < current.depth) relationByChild.set(relation.childSessionId, relation);
  }
  for (const relation of relationByChild.values()) {
    if (!sessions.has(relation.parentSessionId)) continue;
    const siblings = childRelations.get(relation.parentSessionId) ?? [];
    siblings.push(relation);
    childRelations.set(relation.parentSessionId, siblings);
  }

  const baseNode = (sessionId: string): Omit<SessionNode, 'children'> | undefined => {
    const node = sessions.get(sessionId);
    if (!node) return undefined;
    const relation = relationByChild.get(sessionId);
    const parent = relation ? sessions.get(relation.parentSessionId) : undefined;
    return {
      ...node,
      ...(relation ? { relation } : {}),
      ...(parent ? { parentTitle: parent.session.title } : {}),
    };
  };

  const buildNode = (
    sessionId: string,
    groupProjectId: string,
    groupWorkspaceId: string,
    ancestry: ReadonlySet<string>,
  ): SessionNode | null => {
    if (ancestry.has(sessionId)) return null;
    const node = baseNode(sessionId);
    if (!node) return null;
    const nextAncestry = new Set(ancestry).add(sessionId);
    const children = (childRelations.get(sessionId) ?? [])
      .filter((relation) => {
        const child = sessions.get(relation.childSessionId);
        if (!child) return false;
        return relation.owner === 'provider-native'
          || (
            child.session.projectId === groupProjectId
            && child.session.workspaceId === groupWorkspaceId
          );
      })
      .map((relation) => buildNode(
        relation.childSessionId,
        groupProjectId,
        groupWorkspaceId,
        nextAncestry,
      ))
      .filter((child): child is SessionNode => child !== null)
      .sort(compareNodes);
    return { ...node, children };
  };

  const rootsByWorkspace = new Map<string, string[]>();
  for (const node of sessions.values()) {
    const relation = relationByChild.get(node.session.id);
    if (relation?.owner === 'provider-native') continue;
    const parent = relation ? sessions.get(relation.parentSessionId) : undefined;
    const nestedInSameWorkspace = parent
      && parent.session.projectId === node.session.projectId
      && parent.session.workspaceId === node.session.workspaceId;
    if (nestedInSameWorkspace) continue;
    const roots = rootsByWorkspace.get(node.session.workspaceId) ?? [];
    roots.push(node.session.id);
    rootsByWorkspace.set(node.session.workspaceId, roots);
  }

  const workspaceGroups = new Map<string, WorkspaceGroup[]>();
  for (const [workspaceId, rootIds] of rootsByWorkspace) {
    const workspace = workspaces.get(workspaceId);
    const first = sessions.get(rootIds[0] ?? '');
    if (!first) continue;
    const projectId = workspace?.projectId ?? first.session.projectId;
    const roots = rootIds
      .map((sessionId) => buildNode(sessionId, projectId, workspaceId, new Set()))
      .filter((node): node is SessionNode => node !== null)
      .sort(compareNodes);
    if (roots.length === 0) continue;
    const group: WorkspaceGroup = {
      id: workspaceId,
      label: workspace?.name ?? workspaceId,
      kind: workspace?.kind ?? 'local',
      path: workspace?.rootPath ?? '',
      sessions: roots,
    };
    const siblings = workspaceGroups.get(projectId) ?? [];
    siblings.push(group);
    workspaceGroups.set(projectId, siblings);
  }

  return [...workspaceGroups]
    .map(([projectId, groups]): ProjectGroup => ({
      id: projectId,
      label: projects.get(projectId)?.name ?? projectId,
      workspaces: groups.sort((left, right) => (
        left.kind.localeCompare(right.kind)
        || left.label.localeCompare(right.label)
        || left.id.localeCompare(right.id)
      )),
    }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

function sessionCount(groups: readonly ProjectGroup[]): number {
  const countNode = (node: SessionNode): number => 1 + node.children.reduce(
    (total, child) => total + countNode(child),
    0,
  );
  return groups.reduce((projectTotal, project) => projectTotal + project.workspaces.reduce(
    (workspaceTotal, workspace) => workspaceTotal + workspace.sessions.reduce(
      (total, session) => total + countNode(session),
      0,
    ),
    0,
  ), 0);
}

function SessionRow({
  node,
  onOpenSession,
}: {
  readonly node: SessionNode;
  readonly onOpenSession: (input: DaemonAgentSessionOpenInput) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const providerOwned = node.relation?.owner === 'provider-native';
  const attached = node.relation !== undefined;
  const stateLabel = t(`agentHub.structuredSessions.state.${node.agent.state}`);
  const provenance = providerOwned
    ? t('agentHub.structuredSessions.providerChild', { parent: node.parentTitle ?? node.relation?.parentSessionId })
    : attached
      ? t('agentHub.structuredSessions.managedChild', { parent: node.parentTitle ?? node.relation?.parentSessionId })
      : null;

  return (
    <li className="daemon-agent-session-item">
      <button
        type="button"
        className="daemon-agent-session"
        data-session-id={node.session.id}
        data-state={node.agent.state}
        data-owner={providerOwned ? 'provider-native' : 'managed'}
        onClick={() => onOpenSession({
          sessionId: node.session.id,
          title: node.session.title,
          providerLabel: node.providerLabel,
        })}
        aria-label={t('agentHub.structuredSessions.open', {
          title: node.session.title,
          provider: node.providerLabel,
          state: stateLabel,
        })}
      >
        {attached ? <CornerDownRight aria-hidden="true" /> : <Bot aria-hidden="true" />}
        <span className="daemon-agent-session__identity">
          <strong>{node.session.title}</strong>
          <small>
            <span>{node.providerLabel}</span>
            {node.agent.model && <span>{node.agent.model}</span>}
            <span>{stateLabel}</span>
          </small>
          {provenance && (
            <small className="daemon-agent-session__provenance">
              {provenance}
              {providerOwned && <> · {t('agentHub.structuredSessions.readOnly')}</>}
            </small>
          )}
        </span>
        <span className="daemon-agent-session__state" data-state={node.agent.state}>
          <span aria-hidden="true" />
          <span className="ez-ui-visually-hidden">{stateLabel}</span>
        </span>
      </button>
      {node.children.length > 0 && (
        <ol className="daemon-agent-session-children">
          {node.children.map((child) => (
            <SessionRow key={child.session.id} node={child} onOpenSession={onOpenSession} />
          ))}
        </ol>
      )}
    </li>
  );
}

/** Live, read-only navigation projection of the main-owned daemon snapshot. */
export function DaemonAgentSessions({
  onOpenSession,
  access = rendererCapabilities.daemon,
}: DaemonAgentSessionsProps): JSX.Element {
  const { t } = useAppTranslation();
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState<'load' | 'refresh' | null>(null);
  const mountedRef = useRef(false);
  const lifecycleGenerationRef = useRef(0);
  const snapshotRef = useRef<DaemonSnapshot | null>(null);
  const eventCursorRef = useRef<Pick<DaemonSnapshot, 'revision' | 'eventSequence'> | null>(null);
  const requiredEventSequenceRef = useRef(0);
  const requiredRevisionRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshQueuedRef = useRef(false);

  const refresh = useCallback((mode: 'initial' | 'background' | 'recovery' | 'retry'): Promise<void> => {
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      if (mode === 'recovery' && mountedRef.current) setRecovering(true);
      return refreshInFlightRef.current;
    }
    if (mountedRef.current) {
      if (mode === 'initial' || (mode === 'retry' && snapshotRef.current === null)) setLoading(true);
      if (mode === 'recovery') setRecovering(true);
    }
    const generation = lifecycleGenerationRef.current;
    const request = Promise.resolve()
      .then(() => access.getSnapshot())
      .then((next) => {
        if (!mountedRef.current || lifecycleGenerationRef.current !== generation) return;
        if (!next) throw new Error('Daemon snapshot unavailable.');
        const current = snapshotRef.current;
        if (
          current
          && (next.revision < current.revision || next.eventSequence < current.eventSequence)
        ) throw new Error('Daemon snapshot regressed.');
        if (
          next.eventSequence < requiredEventSequenceRef.current
          || next.revision < requiredRevisionRef.current
        ) throw new Error('Daemon snapshot has not reached the observed event.');
        snapshotRef.current = next;
        const cursor = eventCursorRef.current;
        if (!cursor || next.eventSequence > cursor.eventSequence) {
          eventCursorRef.current = {
            revision: next.revision,
            eventSequence: next.eventSequence,
          };
        } else if (next.eventSequence === cursor.eventSequence && next.revision > cursor.revision) {
          eventCursorRef.current = { ...cursor, revision: next.revision };
        }
        setSnapshot(next);
        setError(null);
      })
      .catch(() => {
        if (!mountedRef.current || lifecycleGenerationRef.current !== generation) return;
        setError(snapshotRef.current ? 'refresh' : 'load');
      })
      .finally(() => {
        if (refreshInFlightRef.current === request) refreshInFlightRef.current = null;
        if (!mountedRef.current || lifecycleGenerationRef.current !== generation) return;
        setLoading(false);
        setRecovering(false);
        if (refreshQueuedRef.current) {
          refreshQueuedRef.current = false;
          void refresh('background');
        }
      });
    refreshInFlightRef.current = request;
    return request;
  }, [access]);

  useEffect(() => {
    mountedRef.current = true;
    lifecycleGenerationRef.current += 1;
    const generation = lifecycleGenerationRef.current;
    const onObservationError = (): void => {
      if (!mountedRef.current || lifecycleGenerationRef.current !== generation) return;
      setError(snapshotRef.current ? 'refresh' : 'load');
    };
    let stop = (): void => undefined;
    try {
      stop = access.observeEvents((event: DaemonEvent) => {
        if (lifecycleGenerationRef.current !== generation) return;
        const cursor = eventCursorRef.current;
        if (!cursor) {
          requiredEventSequenceRef.current = Math.max(requiredEventSequenceRef.current, event.sequence);
          requiredRevisionRef.current = Math.max(requiredRevisionRef.current, event.revision);
          void refresh('recovery');
          return;
        }
        const continuity = classifyDaemonEvent(cursor, event);
        if (continuity === 'duplicate') return;
        if (continuity === 'next') {
          eventCursorRef.current = {
            revision: event.revision,
            eventSequence: event.sequence,
          };
          if (!daemonEventAffectsAgentSessionProjection(event)) return;
          requiredEventSequenceRef.current = Math.max(requiredEventSequenceRef.current, event.sequence);
          requiredRevisionRef.current = Math.max(requiredRevisionRef.current, event.revision);
          void refresh(event.kind === 'runtime.recovery' ? 'recovery' : 'background');
          return;
        }
        requiredEventSequenceRef.current = Math.max(requiredEventSequenceRef.current, event.sequence);
        requiredRevisionRef.current = Math.max(requiredRevisionRef.current, event.revision);
        void refresh('recovery');
      }, onObservationError);
    } catch {
      onObservationError();
    }
    void refresh('initial');
    return () => {
      mountedRef.current = false;
      lifecycleGenerationRef.current += 1;
      refreshInFlightRef.current = null;
      refreshQueuedRef.current = false;
      try {
        stop();
      } catch {
        // Subscription teardown is best-effort after the owner has unmounted.
      }
    };
  }, [access, refresh]);

  const groups = useMemo(() => snapshot ? projectDaemonAgentSessions(snapshot) : [], [snapshot]);
  const count = useMemo(() => sessionCount(groups), [groups]);
  const titleId = useId();

  return (
    <section
      className="daemon-agent-sessions"
      aria-labelledby={titleId}
      aria-busy={loading || recovering || undefined}
      data-testid="daemon-agent-sessions"
    >
      <div className="daemon-agent-sessions__heading">
        <h3 id={titleId}>{t('agentHub.structuredSessions.title')}</h3>
        {count > 0 && <span>{count}</span>}
      </div>
      {loading && !snapshot && (
        <p className="daemon-agent-sessions__note" role="status">
          {t('agentHub.structuredSessions.loading')}
        </p>
      )}
      {recovering && snapshot && (
        <p className="daemon-agent-sessions__note" role="status">
          {t('agentHub.structuredSessions.recovering')}
        </p>
      )}
      {error && (
        <div className="daemon-agent-sessions__error" role="alert">
          <span>{t(`agentHub.structuredSessions.${error === 'load' ? 'loadFailed' : 'refreshFailed'}`)}</span>
          <Button variant="ghost" size="sm" onClick={() => void refresh('retry')}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {snapshot && groups.length === 0 && !error && (
        <p className="daemon-agent-sessions__note">{t('agentHub.structuredSessions.empty')}</p>
      )}
      {groups.length > 0 && (
        <ol className="daemon-agent-project-list">
          {groups.map((project) => (
            <li className="daemon-agent-project" key={project.id}>
              <h4>{project.label}</h4>
              <ol className="daemon-agent-workspace-list">
                {project.workspaces.map((workspace) => (
                  <li className="daemon-agent-workspace" key={workspace.id}>
                    <div className="daemon-agent-workspace__heading">
                      <h5>{workspace.label}</h5>
                      <span>{t(`agentHub.structuredSessions.workspace.${workspace.kind}`)}</span>
                    </div>
                    {workspace.path && <small title={workspace.path}>{workspace.path}</small>}
                    <ol className="daemon-agent-session-list">
                      {workspace.sessions.map((session) => (
                        <SessionRow
                          key={session.session.id}
                          node={session}
                          onOpenSession={onOpenSession}
                        />
                      ))}
                    </ol>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
