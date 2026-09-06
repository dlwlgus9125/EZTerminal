import { Archive, Bot, CornerDownRight, SquareTerminal } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentActivity } from '../shared/agent';

import {
  classifyDaemonEvent,
  type DaemonAgent,
  type DaemonAgentRelation,
  type DaemonEvent,
  type DaemonSession,
  type DaemonSnapshot,
} from '../shared/daemon-protocol';
import type { DaemonAuthorityAvailability } from '../shared/daemon-authority';
import {
  isDaemonSessionArchived,
  isStructuredDaemonAgentSession,
} from '../shared/daemon-session-visibility';
import {
  rendererCapabilities,
  type DaemonAccess,
} from './capability-access';
import { useAppTranslation } from './i18n';
import { Button } from './ui';
import { DaemonSafeModeNotice } from './DaemonSafeModeNotice';
import { TerminalSessionActions } from './TerminalSessionActions';
import { useLiveTerminalSessions, withLiveTerminalSessions } from './use-live-terminal-sessions';
import { readSessionViewState, saveSessionViewState } from './session-view-state';
import './daemon-agent-sessions.css';

export type DaemonAgentSessionListAccess = Pick<
  DaemonAccess,
  'getAvailability' | 'getSnapshot' | 'observeEvents'
>;

export interface DaemonAgentSessionOpenInput {
  readonly sessionId: string;
  readonly title?: string;
  readonly providerLabel?: string;
}

export interface DaemonAgentSessionsProps {
  readonly onOpenSession: (input: DaemonAgentSessionOpenInput) => void;
  readonly access?: DaemonAgentSessionListAccess;
  readonly onOpenTerminal?: (sessionId: string) => void;
  readonly onNewTerminal?: (workspaceId: string) => void;
  readonly onNewSession?: (projectId: string, workspaceId: string) => void;
  readonly projectHeaders?: readonly { readonly id: string; readonly content: ReactNode }[];
  readonly activities?: readonly AgentActivity[];
  readonly query?: string;
}

export type DaemonAgentSessionVisibility = 'active' | 'archived';

interface SessionNode {
  readonly session: DaemonSession;
  readonly agent?: DaemonAgent;
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
  return STATE_RANK[left.agent?.state ?? 'idle'] - STATE_RANK[right.agent?.state ?? 'idle']
    || timestamp(right.session.updatedAt) - timestamp(left.session.updatedAt)
    || left.session.title.localeCompare(right.session.title)
    || left.session.id.localeCompare(right.session.id);
}

/**
 * Builds the compact daemon projection without inventing a second session
 * authority. Same-workspace children stay under their parent. Cross-workspace
 * managed children remain discoverable in their owning Workspace and carry
 * parent provenance. Provider-native children stay below a visible parent;
 * when the visibility filter excludes that parent they remain discoverable as
 * provider-owned roots with parent provenance instead of disappearing.
 */
export function projectDaemonAgentSessions(
  snapshot: DaemonSnapshot,
  visibility: DaemonAgentSessionVisibility = 'active',
  includeTerminals = false,
): readonly ProjectGroup[] {
  const providers = new Map(snapshot.providers.map((provider) => [provider.id, provider.displayName]));
  const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
  const workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
  const agents = new Map(snapshot.agents.map((agent) => [agent.sessionId, agent]));
  const sessionTitles = new Map(snapshot.sessions.map((session) => [session.id, session.title]));
  const sessions = new Map<string, Omit<SessionNode, 'children'>>();

  for (const session of snapshot.sessions) {
    const terminal = includeTerminals && session.kind === 'terminal';
    if (!terminal && !isStructuredDaemonAgentSession(session)) continue;
    const agent = agents.get(session.id);
    if (!agent && !terminal) continue;
    const archived = isDaemonSessionArchived(session, agent) || (terminal && ['completed', 'interrupted', 'failed'].includes(session.state));
    if ((visibility === 'archived') !== archived) continue;
    const workspace = workspaces.get(session.workspaceId);
    sessions.set(session.id, {
      session,
      agent,
      providerLabel: agent ? providers.get(agent.providerId) ?? agent.providerId : 'Terminal',
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
    const parentTitle = relation ? sessionTitles.get(relation.parentSessionId) : undefined;
    return {
      ...node,
      ...(relation ? { relation } : {}),
      ...(parentTitle ? { parentTitle } : {}),
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
    const parent = relation ? sessions.get(relation.parentSessionId) : undefined;
    const nestedUnderSelectedParent = parent && (
      relation?.owner === 'provider-native'
      || (
        parent.session.projectId === node.session.projectId
        && parent.session.workspaceId === node.session.workspaceId
      )
    );
    if (nestedUnderSelectedParent) continue;
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

  if (includeTerminals && visibility === 'active') {
    for (const workspace of snapshot.workspaces) {
      if (workspace.archivedAt || projects.get(workspace.projectId)?.archivedAt) continue;
      const siblings = workspaceGroups.get(workspace.projectId) ?? [];
      if (!siblings.some((entry) => entry.id === workspace.id)) siblings.push({
        id: workspace.id, label: workspace.name, kind: workspace.kind, path: workspace.rootPath, sessions: [],
      });
      workspaceGroups.set(workspace.projectId, siblings);
    }
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
  onOpenTerminal,
  onNewTerminal,
  activities,
}: {
  readonly node: SessionNode;
  readonly onOpenSession: (input: DaemonAgentSessionOpenInput) => void;
  readonly onOpenTerminal?: (sessionId: string) => void;
  readonly onNewTerminal?: (workspaceId: string) => void;
  readonly activities?: readonly AgentActivity[];
}): JSX.Element {
  const { t } = useAppTranslation();
  const providerOwned = node.relation?.owner === 'provider-native';
  const attached = node.relation !== undefined;
  const terminal = node.session.kind === 'terminal';
  const ended = terminal && ['completed', 'interrupted', 'failed', 'archived'].includes(node.session.state);
  const activity = activities?.find((item) => item.sessionId === node.session.id && item.live);
  const providerLabel = activity?.providerLabel ?? activity?.provider ?? node.providerLabel;
  const state = node.agent?.state ?? (ended ? 'done' : 'idle');
  const stateLabel = terminal ? ended ? t('sessionNavigation.ended') : activity ? t(`agentHub.status.${activity.status}`) : t('sessionNavigation.available') : t(`agentHub.structuredSessions.state.${state}`);
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
        data-state={state}
        data-owner={providerOwned ? 'provider-native' : 'managed'}
        onClick={() => terminal ? ended ? onNewTerminal?.(node.session.workspaceId) : onOpenTerminal?.(node.session.id) : onOpenSession({
          sessionId: node.session.id,
          title: node.session.title,
          providerLabel: node.providerLabel,
        })}
        aria-label={t('agentHub.structuredSessions.open', {
          title: node.session.title,
          provider: providerLabel,
          state: stateLabel,
        })}
      >
        {terminal ? <SquareTerminal aria-hidden="true" /> : attached ? <CornerDownRight aria-hidden="true" /> : <Bot aria-hidden="true" />}
        <span className="daemon-agent-session__identity">
          <strong>{node.session.title}</strong>
          <small>
            <span>{providerLabel}</span>
            {node.agent?.model && <span>{node.agent.model}</span>}
            <span>{stateLabel}</span>
            {ended && <span>{t('sessionNavigation.newAtLocation')}</span>}
          </small>
          {provenance && (
            <small className="daemon-agent-session__provenance">
              {provenance}
              {providerOwned && <> · {t('agentHub.structuredSessions.readOnly')}</>}
            </small>
          )}
        </span>
        <span className="daemon-agent-session__state" data-state={state}>
          <span aria-hidden="true" />
          <span className="ez-ui-visually-hidden">{stateLabel}</span>
        </span>
      </button>
      {terminal && !ended && onOpenTerminal && window.ezterminal && <TerminalSessionActions sessionId={node.session.id} title={node.session.title} access={window.ezterminal} />}
      {node.children.length > 0 && (
        <ol className="daemon-agent-session-children">
          {node.children.map((child) => (
            <SessionRow key={child.session.id} node={child} onOpenSession={onOpenSession} onOpenTerminal={onOpenTerminal} onNewTerminal={onNewTerminal} activities={activities} />
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
  onOpenTerminal,
  onNewTerminal,
  onNewSession,
  projectHeaders,
  activities,
  query = '',
}: DaemonAgentSessionsProps): JSX.Element {
  const { t } = useAppTranslation();
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null);
  const [availability, setAvailability] = useState<DaemonAuthorityAvailability | null>();
  const [loading, setLoading] = useState(true);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState<'load' | 'refresh' | null>(null);
  const [visibility, setVisibility] = useState<DaemonAgentSessionVisibility>('active');
  const liveIds = useLiveTerminalSessions(onOpenTerminal ? window.ezterminal : undefined);
  const navigationSnapshot = useMemo(() => withLiveTerminalSessions(snapshot, liveIds), [snapshot, liveIds]);
  const [expanded, setExpanded] = useState<readonly string[]>(() => readSessionViewState('desktop-project-sessions-expanded') ?? []);
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
    let cancelled = false;
    void Promise.resolve()
      .then(() => access.getAvailability())
      .then((next) => {
        if (!cancelled) setAvailability(next);
      })
      .catch(() => {
        if (!cancelled) setAvailability(null);
      });
    return () => { cancelled = true; };
  }, [access]);

  useEffect(() => {
    if (availability === undefined) return undefined;
    if (availability?.state === 'legacy-only-safe-mode') {
      setLoading(false);
      setRecovering(false);
      setError(null);
      return undefined;
    }
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
  }, [access, availability, refresh]);

  const activeGroups = useMemo(
    () => navigationSnapshot ? projectDaemonAgentSessions(navigationSnapshot, 'active', Boolean(onOpenTerminal)) : [],
    [navigationSnapshot, onOpenTerminal],
  );
  const archivedGroups = useMemo(
    () => navigationSnapshot ? projectDaemonAgentSessions(navigationSnapshot, 'archived', Boolean(onOpenTerminal)) : [],
    [navigationSnapshot, onOpenTerminal],
  );
  const activeCount = useMemo(() => sessionCount(activeGroups), [activeGroups]);
  const archivedCount = useMemo(() => sessionCount(archivedGroups), [archivedGroups]);
  const baseGroups = visibility === 'archived' ? archivedGroups : activeGroups;
  const groups = [...baseGroups];
  if (visibility === 'active') for (const header of projectHeaders ?? []) {
    if (!groups.some((group) => group.id === header.id)) groups.push({ id: header.id, label: '', workspaces: [] });
  }
  const visibleGroups = groups.filter((group) => !query.trim() || projectHeaders?.some((header) => header.id === group.id) || group.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const titleId = useId();

  if (availability?.state === 'legacy-only-safe-mode') {
    return (
      <section
        className="daemon-agent-sessions"
        aria-labelledby={titleId}
        data-testid="daemon-agent-sessions"
        data-availability="legacy-only-safe-mode"
      >
        <div className="daemon-agent-sessions__heading">
          <h3 id={titleId}>{t('agentHub.structuredSessions.title')}</h3>
        </div>
        <DaemonSafeModeNotice availability={availability} showRecoveryPath compact />
        {projectHeaders && <ol className="daemon-agent-project-list">{projectHeaders.map((header) => <li className="daemon-agent-project" key={header.id}>{header.content}</li>)}</ol>}
      </section>
    );
  }

  return (
    <section
      className="daemon-agent-sessions"
      aria-labelledby={titleId}
      aria-busy={loading || recovering || undefined}
      data-testid="daemon-agent-sessions"
      data-visibility={visibility}
    >
      <div className="daemon-agent-sessions__heading">
        <h3 id={titleId}>{t('agentHub.structuredSessions.title')}</h3>
        <div
          className="daemon-agent-sessions__filters"
          role="group"
          aria-label={t('agentHub.structuredSessions.filterLabel')}
        >
          <button
            type="button"
            aria-pressed={visibility === 'active'}
            onClick={() => setVisibility('active')}
            data-testid="daemon-agent-sessions-active"
          >
            {t('agentHub.structuredSessions.current')} <span>{activeCount}</span>
          </button>
          <button
            type="button"
            aria-pressed={visibility === 'archived'}
            onClick={() => setVisibility('archived')}
            data-testid="daemon-agent-sessions-archived"
          >
            <Archive aria-hidden="true" />
            {t('agentHub.structuredSessions.archived')} <span>{archivedCount}</span>
          </button>
        </div>
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
        <p className="daemon-agent-sessions__note">
          {t(`agentHub.structuredSessions.${visibility === 'archived' ? 'archivedEmpty' : 'empty'}`)}
        </p>
      )}
      {groups.length > 0 && (
        <ol className="daemon-agent-project-list">
          {visibleGroups.map((project) => (
            <li className="daemon-agent-project" key={project.id}>
              {projectHeaders?.find((header) => header.id === project.id)?.content ?? <h4>{project.label}</h4>}
              <details open={!projectHeaders || expanded.includes(project.id)} onToggle={(event) => {
                const open = event.currentTarget.open;
                setExpanded((current) => {
                  const next = open ? [...new Set([...current, project.id])] : current.filter((id) => id !== project.id);
                  saveSessionViewState('desktop-project-sessions-expanded', next);
                  return next;
                });
              }}>
              <summary>{t('sessionNavigation.sessions', { count: sessionCount([project]) })}</summary>
              <ol className="daemon-agent-workspace-list">
                {project.workspaces.map((workspace) => (
                  <li className="daemon-agent-workspace" key={workspace.id}>
                    <div className="daemon-agent-workspace__heading">
                      <h5>{workspace.label}</h5>
                      <span>{t(`agentHub.structuredSessions.workspace.${workspace.kind}`)}</span>
                      {visibility === 'active' && onNewSession && <Button variant="ghost" size="sm" onClick={() => onNewSession(project.id, workspace.id)} aria-label={`${t('agentHub.newAgentRun')}: ${workspace.label}`}>{t('agentHub.newAgentRun')}</Button>}
                    </div>
                    {workspace.path && <small title={workspace.path}>{workspace.path}</small>}
                    <ol className="daemon-agent-session-list">
                      {workspace.sessions.map((session) => (
                        <SessionRow
                          key={session.session.id}
                          node={session}
                          onOpenSession={onOpenSession}
                          onOpenTerminal={onOpenTerminal}
                          onNewTerminal={onNewTerminal}
                          activities={activities}
                        />
                      ))}
                    </ol>
                  </li>
                ))}
              </ol>
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
