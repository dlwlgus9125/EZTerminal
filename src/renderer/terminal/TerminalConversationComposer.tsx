import { useEffect, useMemo, useState } from 'react';

import type { ChatMessageContext } from '../../shared/chat-message';
import type { ConversationFolders } from '../../shared/conversation-folders';
import type { DaemonCommand, DaemonSnapshot, DaemonTranscriptItem } from '../../shared/daemon-protocol';
import { isDaemonSessionArchived } from '../../shared/daemon-session-visibility';
import { rendererCapabilities, type CapabilityAccess } from '../capability-access';
import type { ChatStateAccess } from '../chat-recovery';
import { ChatRecoveryNotice } from '../ChatRecoveryNotice';
import {
  changeConversationSettings,
  queueConversationTurn,
  reconcileConversationSubmit,
  runConversationLifecycle,
  submitConversationMessage,
  type ConversationCommandAccess,
} from '../conversation-commands';
import { conversationQueue } from '../conversation-queue';
import { desktopFileSearch, pathForDrop } from '../StructuredAgentDockPanel';
import { StructuredAgentSessionPanel, type StructuredAgentUiResult } from '../StructuredAgentSession';
import { structuredAgentModelOptions } from '../structured-agent-create';
import { useChatRecovery } from '../use-chat-recovery';
import { useProviderModelCatalogs } from '../use-provider-models';

/** Queued messages are read from this many newest transcript items. */
const QUEUE_TAIL = 200;

export interface TerminalConversationComposerProps {
  readonly sessionId: string;
  /** The shell's live daemon snapshot. */
  readonly snapshot: DaemonSnapshot | null;
  readonly capabilities?: CapabilityAccess;
  readonly chatStateAccess?: ChatStateAccess;
  /** The host accepted a message for this conversation. */
  readonly onSent?: (sessionId: string) => void;
  /** `/new`: send to a new conversation instead. */
  readonly onNewConversation?: () => void;
}

/**
 * The conversation's own message box, for typing into it from a terminal: the same
 * settings, slash commands, queue, stop and send as its tab, and the same draft
 * (one shared recovery controller), so text typed in either place is in both and a
 * send from either clears both. Only the box shows; the answer is read in the tab.
 */
export function TerminalConversationComposer({
  sessionId, snapshot, capabilities = rendererCapabilities, chatStateAccess, onSent, onNewConversation,
}: TerminalConversationComposerProps): JSX.Element {
  const session = snapshot?.sessions.find((candidate) => candidate.id === sessionId);
  const agent = snapshot?.agents.find((candidate) => candidate.sessionId === sessionId);
  // The same scope source as the conversation tab (the snapshot session's project), so both share one draft.
  const recovery = useChatRecovery(session?.projectId, session ? sessionId : null, chatStateAccess);
  const capabilityClient = useMemo(() => typeof window.ezterminal?.agentCapabilitiesList === 'function' ? {
    list: window.ezterminal.agentCapabilitiesList,
    manage: window.ezterminal.agentCapabilitiesManage,
  } : undefined, []);
  const catalogs = useProviderModelCatalogs(snapshot, capabilities);
  const workspace = snapshot?.workspaces.find((candidate) => candidate.id === session?.workspaceId);
  const provider = snapshot?.providers.find((candidate) => candidate.id === agent?.providerId);

  // The folders main hands this conversation's AI, read again when the project's folders change.
  const readFolders = window.ezterminalDesktop?.getConversationFolders;
  const folderKey = useMemo(() => session ? JSON.stringify([session.id, session.workspaceId, ...(snapshot?.workspaces ?? [])
    .filter((candidate) => candidate.projectId === session.projectId)
    .map((candidate) => [candidate.id, candidate.rootPath, candidate.archivedAt ?? ''])]) : '', [session, snapshot?.workspaces]);
  const [folders, setFolders] = useState<ConversationFolders>();
  useEffect(() => {
    if (!readFolders || !folderKey) { setFolders(undefined); return undefined; }
    let alive = true;
    void readFolders({ sessionId }).then((found) => { if (alive) setFolders(found ?? undefined); }).catch(() => undefined);
    return () => { alive = false; };
  }, [readFolders, folderKey, sessionId]);

  // Queued messages show with their text: read the transcript's tail while any wait.
  const queued = agent?.queuedTurnCount ?? 0;
  const head = snapshot?.transcriptHeads.find((candidate) => candidate.sessionId === sessionId)?.lastSequence ?? 0;
  const [tail, setTail] = useState<readonly DaemonTranscriptItem[]>([]);
  useEffect(() => {
    if (queued === 0) { setTail([]); return undefined; }
    let alive = true;
    const after = Math.max(0, head - QUEUE_TAIL);
    void Promise.resolve()
      .then(() => capabilities.daemon.getTranscript(sessionId, after, QUEUE_TAIL))
      .then((items) => { if (alive) setTail(items.filter((item) => item.sessionId === sessionId)); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [capabilities, head, queued, sessionId]);

  if (!session || !agent) {
    return (
      <p className="terminal-ai-missing" role="status" data-testid="terminal-ai-missing">
        {snapshot ? '이 대화를 찾을 수 없습니다. 보낼 곳을 다시 고르세요.' : '대화를 불러오는 중…'}
      </p>
    );
  }

  const access: ConversationCommandAccess = {
    latestSnapshot: () => capabilities.daemon.getSnapshot(),
    sendCommand: (command: DaemonCommand) => Promise.resolve().then(() => capabilities.daemon.sendCommand(command)).catch(() => null),
  };
  const relation = snapshot?.agentRelations.find((candidate) => candidate.childSessionId === sessionId && candidate.detachedAt === undefined);
  const owner = relation?.owner ?? 'managed';
  const historyOnly = isDaemonSessionArchived(session, agent);
  const providerId = agent.providerId;
  const fileSearch = desktopFileSearch(workspace?.rootPath);
  const shownFolders = folders ?? (readFolders && workspace ? { primary: workspace.rootPath, additional: [], missing: [] } : undefined);
  const send = (type: 'agent.submit' | 'agent.interrupt-and-submit') => (prompt: string, context?: ChatMessageContext): Promise<StructuredAgentUiResult> => (
    submitConversationMessage(access, { sessionId, recovery: recovery.controller, type, prompt, ...(context ? { context } : {}), onAccepted: () => onSent?.(sessionId) })
  );

  return (
    <StructuredAgentSessionPanel
      presentation="composer"
      capabilityClient={capabilityClient}
      sessionId={sessionId}
      title={session.title}
      providerId={providerId}
      providerLabel={provider?.displayName ?? (providerId || 'Agent')}
      usage={snapshot?.agentUsage?.[sessionId]}
      workspace={workspace
        ? { id: workspace.id, label: workspace.name, kind: workspace.kind, path: workspace.rootPath }
        : { id: session.workspaceId, label: 'Workspace unavailable', kind: 'local' }}
      {...(shownFolders ? { folders: shownFolders } : {})}
      model={agent.model}
      modelOptions={structuredAgentModelOptions(provider?.capabilities ?? [], agent.model, catalogs[providerId])}
      permissionPreset={agent.permissionPreset}
      state={historyOnly ? 'archived' : agent.state}
      queuedCount={queued}
      queueItems={conversationQueue(sessionId, snapshot?.turns ?? [], tail)}
      onQueueAction={!historyOnly && owner === 'managed' && snapshot?.capabilities?.includes('agent-queue')
        ? (item, action) => queueConversationTurn(access, sessionId, item, action)
        : undefined}
      items={[]}
      approvalResponses={snapshot?.capabilities?.includes('approval-response-v1') === true}
      effortSupported={snapshot?.capabilities?.includes('agent-effort-v1') === true}
      {...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {})}
      {...(fileSearch ? { fileSearch } : {})}
      pathForDrop={pathForDrop}
      historyOnly={historyOnly}
      owner={owner}
      supportsMessageContext={provider?.protocol === 'codex-app-server' || provider?.protocol === 'claude-agent-sdk'}
      draftState={recovery.controller ? recovery.view.draft : undefined}
      onDraftChange={(draft) => recovery.controller?.updateDraft(draft)}
      sendDisabled={recovery.view.status !== 'ready'}
      sendDisabledReason={recovery.view.status === 'loading' ? 'Restoring secure draft…' : recovery.view.message}
      recoveryControl={<ChatRecoveryNotice controller={recovery.controller} view={recovery.view} />}
      deliveryUncertain={recovery.view.pendingSubmit !== undefined}
      onReconcileDelivery={() => reconcileConversationSubmit(access, { recovery: recovery.controller, onAccepted: () => onSent?.(sessionId) })}
      onSend={send('agent.submit')}
      onInterruptAndSend={historyOnly ? undefined : send('agent.interrupt-and-submit')}
      onChangeSettings={historyOnly ? undefined : (settings) => changeConversationSettings(access, sessionId, settings)}
      onCancel={!historyOnly && owner === 'managed' ? () => runConversationLifecycle(access, sessionId, 'agent.cancel') : undefined}
      {...(onNewConversation ? { onNewConversation } : {})}
    />
  );
}
