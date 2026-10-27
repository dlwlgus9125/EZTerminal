import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AgentActivity } from '../../../src/shared/agent';
import type { AgentUsage } from '../../../src/shared/agent-usage';
import type { DaemonSnapshot } from '../../../src/shared/daemon-protocol';
import { REMOTE_PROTOCOL_VERSION_WORKFLOW } from '../../../src/shared/remote-protocol';
import type { WorkflowSnapshot } from '../../../src/shared/workflow';
import type { WsEzTerminalTransport } from '../transport/ws-ezterminal';
import {
  askBarUsage,
  feedConversations,
  feedFlows,
  feedProjects,
  feedWaiting,
  flowReadProjects,
  stageSessionIds,
  type FeedConversation,
  type FeedFlow,
  type FeedProject,
  type FeedScope,
  type FeedWaitingItem,
} from './feed-model';

/** One project's flows are read every 10 s while the feed shows them; every project's every 30 s. */
export const FEED_FLOW_READ_MS = { one: 10_000, all: 30_000 } as const;
export const FEED_CONVERSATION_LIMIT = 5;

const scopeKey = (authority: string): string => `ezterminal-feed-scope-v1:${authority}`;

function readScope(authority: string | null): FeedScope {
  if (!authority) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(scopeKey(authority)) ?? 'null') as { scope?: unknown } | null;
    return typeof saved?.scope === 'string' && saved.scope.length > 0 && saved.scope.length <= 256 ? saved.scope : null;
  } catch { return null; }
}

function writeScope(authority: string | null, scope: FeedScope): void {
  if (!authority) return;
  try { localStorage.setItem(scopeKey(authority), JSON.stringify({ scope })); } catch { /* Kept for this run only. */ }
}

export interface FeedData {
  readonly projects: readonly FeedProject[];
  readonly scope: FeedScope;
  readonly setScope: (scope: FeedScope) => void;
  readonly waiting: readonly FeedWaitingItem[];
  readonly flows: readonly FeedFlow[];
  readonly flowsAvailable: boolean;
  readonly conversations: { readonly items: readonly FeedConversation[]; readonly total: number };
  readonly usage: AgentUsage | null;
}

/**
 * The feed's data (I4): the scope chosen in the header, remembered per PC on this phone; flows read from the PC only
 * while the feed is on screen, the app in front and the PC able to report them — the chosen project, or for every
 * project up to six (flow approvals first), one after another; a failed read keeps the last flows.
 */
export function useFeedData({ transport, daemon, liveDaemon, terminalAgents, connected, active, authority }: {
  readonly transport: Pick<WsEzTerminalTransport, 'getWorkflowSnapshot' | 'negotiatedRemoteProtocolVersion'>;
  /** The latest snapshot, a cached one while offline: projects and conversations. */
  readonly daemon: DaemonSnapshot | null;
  /** The connected PC's snapshot only: what waits (a cached approval cannot be answered). */
  readonly liveDaemon: DaemonSnapshot | null;
  /** User-facing terminal agents (orchestration workers left out). */
  readonly terminalAgents: readonly AgentActivity[];
  readonly connected: boolean;
  /** The feed is on screen and the app in front. */
  readonly active: boolean;
  /** The PC this phone is paired with, for the remembered scope. */
  readonly authority: string | null;
}): FeedData {
  const [savedScope, setSavedScope] = useState<FeedScope>(() => readScope(authority));
  useEffect(() => setSavedScope(readScope(authority)), [authority]);
  const projects = useMemo(() => feedProjects(daemon), [daemon]);
  // A project that is gone (archived on the PC) falls back to every project; the choice is kept for when it returns.
  const scope = savedScope !== null && daemon && !projects.some((project) => project.id === savedScope) ? null : savedScope;
  const setScope = useCallback((next: FeedScope) => {
    setSavedScope(next);
    writeScope(authority, next);
  }, [authority]);

  const [workflows, setWorkflows] = useState<ReadonlyMap<string, WorkflowSnapshot>>(() => new Map());
  useEffect(() => setWorkflows(new Map()), [authority]);
  const flowsAvailable = connected && transport.negotiatedRemoteProtocolVersion >= REMOTE_PROTOCOL_VERSION_WORKFLOW;

  const waiting = useMemo(() => feedWaiting(liveDaemon, terminalAgents, workflows), [liveDaemon, terminalAgents, workflows]);
  const conversations = useMemo(() => feedConversations(daemon, scope, {
    stageSessions: stageSessionIds(workflows.values()),
    waitingSessions: new Set(waiting.flatMap((item) => item.sessionId ? [item.sessionId] : [])),
    limit: FEED_CONVERSATION_LIMIT,
  }), [daemon, scope, waiting, workflows]);
  const flows = useMemo(() => feedFlows(workflows, scope, projects), [projects, scope, workflows]);
  const usage = useMemo(() => askBarUsage(daemon, conversations.items)?.usage ?? null, [conversations.items, daemon]);

  // Which projects to read depends on the snapshot alone (not on what the reads return), so reading cannot loop.
  const readProjects = useMemo(() => flowReadProjects(scope, projects, feedWaiting(liveDaemon, terminalAgents),
    feedConversations(daemon, scope, { limit: FEED_CONVERSATION_LIMIT }).items).join('\n'), [daemon, liveDaemon, projects, scope, terminalAgents]);
  // A new flow approval is read at once (its card names the flow).
  const flowApprovals = (liveDaemon?.attention?.items ?? []).filter((item) => item.kind === 'flow-approval').map((item) => item.id).join('\n');

  useEffect(() => {
    if (!active || !flowsAvailable || !readProjects) return;
    const ids = readProjects.split('\n');
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      for (const projectId of ids) {
        if (cancelled) return;
        const result = await transport.getWorkflowSnapshot(projectId).catch(() => null);
        if (cancelled) return;
        if (result?.ok) setWorkflows((current) => new Map(current).set(projectId, result.snapshot));
      }
      if (!cancelled) timer = setTimeout(() => void read(), scope === null ? FEED_FLOW_READ_MS.all : FEED_FLOW_READ_MS.one);
    };
    void read();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [active, flowApprovals, flowsAvailable, readProjects, scope, transport]);

  return { projects, scope, setScope, waiting, flows, flowsAvailable, conversations, usage };
}
