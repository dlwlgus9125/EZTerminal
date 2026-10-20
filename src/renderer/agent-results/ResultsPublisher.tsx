import { useContext, useEffect, useMemo, useRef } from 'react';

import type { DaemonTranscriptItem } from '../../shared/daemon-protocol';
import { AgentResultsContext } from './AgentResultsContext';
import { isArtifactItem } from './derive-results';
import { publishResultsDock, type ResultsDockPart } from './results-source-store';

export type ResultsPublisherProps = Omit<ResultsDockPart, 'baselineSequence'>;

/**
 * A result counts as new when it was made after this conversation opened here
 * (or just before: a new conversation's tab switches from its start panel to
 * the conversation as the first reply arrives).
 */
const RECENT_MS = 60_000;

/**
 * Renders nothing. Publishes what the conversation loaded for its Results tab
 * and asks for the tab when a new result arrives while the person is here:
 * reopening an older conversation never opens it.
 */
export function ResultsPublisher({ ownerPanelId, ...part }: ResultsPublisherProps & { readonly ownerPanelId: string }): null {
  const host = useContext(AgentResultsContext);
  const baseline = useRef<number | undefined>(undefined);
  const openedAt = useRef(Date.now());
  const scanned = useRef({ upTo: 0, fresh: 0 });
  const asked = useRef(false);
  const { items, loaded, sessionId, historyOnly } = part;

  if (loaded && baseline.current === undefined) baseline.current = maxSequence(items);
  // Only items past the last scan are parsed; streaming deltas arrive several times a second.
  for (const item of items) {
    if (item.sequence <= scanned.current.upTo) continue;
    const created = Date.parse(item.createdAt);
    if (Number.isFinite(created) && created >= openedAt.current - RECENT_MS && isArtifactItem(item)) {
      scanned.current.fresh = Math.max(scanned.current.fresh, item.sequence);
    }
  }
  scanned.current.upTo = Math.max(scanned.current.upTo, maxSequence(items));

  // The host passes fresh closures every render; the Results tab gets stable ones.
  const latest = useRef(part);
  latest.current = part;
  const callbacks = useMemo(() => ({
    readTranscriptPage: (after: number, limit: number) => latest.current.readTranscriptPage?.(after, limit) ?? Promise.resolve([]),
    openRelatedSession: (id: string) => latest.current.openRelatedSession?.(id),
    openProjectFiles: () => latest.current.openProjectFiles?.(),
  }), []);
  const hasRead = Boolean(part.readTranscriptPage);
  const hasRelated = Boolean(part.openRelatedSession);
  const hasProjectFiles = Boolean(part.openProjectFiles);
  const childrenKey = part.children.map((child) => `${child.sessionId}:${child.state}:${child.title}`).join('|');
  const children = useMemo(() => part.children, [childrenKey]); // eslint-disable-line react-hooks/exhaustive-deps -- identity follows content
  const baselineSequence = baseline.current ?? 0;

  useEffect(() => {
    publishResultsDock(ownerPanelId, {
      sessionId,
      title: part.title,
      providerLabel: part.providerLabel,
      ...(part.workspaceRoot ? { workspaceRoot: part.workspaceRoot } : {}),
      items,
      children,
      transcriptFloor: part.transcriptFloor,
      loaded,
      baselineSequence,
      historyOnly,
      turnActive: part.turnActive,
      ...(hasRead ? { readTranscriptPage: callbacks.readTranscriptPage } : {}),
      ...(hasRelated ? { openRelatedSession: callbacks.openRelatedSession } : {}),
      ...(hasProjectFiles ? { openProjectFiles: callbacks.openProjectFiles } : {}),
    });
  }, [baselineSequence, callbacks, children, hasProjectFiles, hasRead, hasRelated, historyOnly, items, loaded, ownerPanelId,
    part.providerLabel, part.title, part.transcriptFloor, part.turnActive, part.workspaceRoot, sessionId]);
  useEffect(() => () => publishResultsDock(ownerPanelId, undefined), [ownerPanelId]);

  const fresh = scanned.current.fresh;
  useEffect(() => {
    if (!host || historyOnly || asked.current || !loaded || fresh === 0) return;
    asked.current = true;
    host.requestAutoOpen(ownerPanelId, sessionId);
  }, [fresh, historyOnly, host, loaded, ownerPanelId, sessionId]);
  return null;
}

function maxSequence(items: readonly DaemonTranscriptItem[]): number {
  let max = 0;
  for (const item of items) if (Number.isSafeInteger(item.sequence) && item.sequence > max) max = item.sequence;
  return max;
}
