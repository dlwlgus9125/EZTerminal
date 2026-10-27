import { useEffect, useMemo, useRef, useState } from 'react';

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
import { desktopFileSearch, pathForDrop } from '../conversation-desktop-access';
import { conversationQueue } from '../conversation-queue';
import { useAppTranslation } from '../i18n';
import { StructuredAgentSessionPanel, type StructuredAgentUiResult } from '../StructuredAgentSession';
import { structuredAgentModelOptions } from '../structured-agent-create';
import { useChatRecovery } from '../use-chat-recovery';
import { useProviderModelCatalogs } from '../use-provider-models';
import { useWorkflowConversationScope } from '../workflow/WorkflowConversationContext';

/** Queued messages are looked for this far back, page by page, before giving up. */
const QUEUE_PAGE = 500;
const QUEUE_MAX_PAGES = 6;

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
  /** The phone's terminal shows the box in the phone's own layout (send button, no Enter-to-send). */
  readonly variant?: 'desktop' | 'mobile';
}

/**
 * The text of every queued message: read back from the transcript page by page
 * until each queued turn's message is found. `complete` is false while any is
 * missing — Stop then is not offered, because stopping hands queued messages
 * back to the box and the daemon drops the ones it could not hand back.
 */
function useQueuedMessages(
  snapshot: DaemonSnapshot | null,
  sessionId: string,
  capabilities: CapabilityAccess,
): { readonly items: readonly DaemonTranscriptItem[]; readonly complete: boolean } {
  const queued = useMemo(() => (snapshot?.turns ?? [])
    .filter((turn) => turn.sessionId === sessionId && turn.state === 'queued')
    .map((turn) => turn.id), [sessionId, snapshot?.turns]);
  const queuedKey = queued.join('\0');
  const head = snapshot?.transcriptHeads.find((candidate) => candidate.sessionId === sessionId)?.lastSequence ?? 0;
  const headRef = useRef(head);
  headRef.current = head;
  const [state, setState] = useState<{
    readonly key: string; readonly items: readonly DaemonTranscriptItem[]; readonly complete: boolean;
  }>({ key: '', items: [], complete: true });
  // A read that failed (host busy, reconnecting) is tried again when the next snapshot arrives
  // (whatever its revision); one in flight is not restarted, and a success does not read again.
  // A read that looked as far back as it may and found nothing is not retried.
  const failedRef = useRef(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (failedRef.current) {
      failedRef.current = false;
      setAttempt((value) => value + 1);
    }
  }, [snapshot]);
  useEffect(() => {
    if (!queuedKey) { setState({ key: '', items: [], complete: true }); return undefined; }
    const wanted = new Set(queuedKey.split('\0'));
    let alive = true;
    failedRef.current = false;
    void (async () => {
      const found = new Map<string, DaemonTranscriptItem>();
      let before = headRef.current;
      for (let page = 0; page < QUEUE_MAX_PAGES && before > 0 && found.size < wanted.size; page += 1) {
        const after = Math.max(0, before - QUEUE_PAGE);
        const items = await capabilities.daemon.getTranscript(sessionId, after, before - after);
        for (const item of items) {
          if (item.sessionId === sessionId && item.kind === 'user-message' && item.turnId && wanted.has(item.turnId)) found.set(item.turnId, item);
        }
        before = after;
      }
      if (alive) setState({ key: queuedKey, items: [...found.values()], complete: found.size === wanted.size });
    })().catch(() => {
      if (!alive) return;
      failedRef.current = true;
      setState({ key: queuedKey, items: [], complete: false });
    });
    return () => { alive = false; };
  }, [attempt, capabilities, queuedKey, sessionId]);
  return state.key === queuedKey ? state : { items: [], complete: !queuedKey };
}

/**
 * The conversation's own message box, for typing into it from a terminal: the same
 * settings, slash commands, queue, stop and send as its tab, and the same draft
 * (one shared recovery controller), so text typed in either place is in both and a
 * send from either clears both. Only the box shows; the answer is read in the tab.
 */
export function TerminalConversationComposer({
  sessionId, snapshot, capabilities = rendererCapabilities, chatStateAccess, onSent, onNewConversation, variant = 'desktop',
}: TerminalConversationComposerProps): JSX.Element {
  const { t } = useAppTranslation();
  const session = snapshot?.sessions.find((candidate) => candidate.id === sessionId);
  const agent = snapshot?.agents.find((candidate) => candidate.sessionId === sessionId);
  // The same scope source as the conversation tab (the snapshot session's project), so both share one draft.
  const recovery = useChatRecovery(session?.projectId, session ? sessionId : null, chatStateAccess);
  const capabilityClient = useMemo(() => typeof window.ezterminal?.agentCapabilitiesList === 'function' ? {
    list: window.ezterminal.agentCapabilitiesList,
    manage: window.ezterminal.agentCapabilitiesManage,
  } : undefined, []);
  // A flow stage's conversation follows its stage: read only once the stage or flow is archived, like its tab.
  const workflowAccess = useMemo(() => typeof window.ezterminal?.getWorkflowSnapshot === 'function'
    ? { getWorkflowSnapshot: (id: string) => window.ezterminal.getWorkflowSnapshot(id) } : undefined, []);
  const workflow = useWorkflowConversationScope(workflowAccess, session?.projectId, session ? sessionId : null);
  const catalogs = useProviderModelCatalogs(snapshot, capabilities);
  const queue = useQueuedMessages(snapshot, sessionId, capabilities);
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

  if (!session || !agent) {
    return (
      <p className="terminal-ai-missing" role="status" data-testid="terminal-ai-missing">
        {snapshot ? t('terminalAi.targetMissing') : t('terminalAi.targetLoading')}
      </p>
    );
  }

  const access: ConversationCommandAccess = {
    latestSnapshot: () => capabilities.daemon.getSnapshot(),
    sendCommand: (command: DaemonCommand) => Promise.resolve().then(() => capabilities.daemon.sendCommand(command)).catch(() => null),
  };
  const relation = snapshot?.agentRelations.find((candidate) => candidate.childSessionId === sessionId && candidate.detachedAt === undefined);
  const owner = relation?.owner ?? 'managed';
  const historyOnly = isDaemonSessionArchived(session, agent) || workflow.scope?.readOnly === true;
  const providerId = agent.providerId;
  const fileSearch = desktopFileSearch(workspace?.rootPath);
  const shownFolders = folders ?? (readFolders && workspace ? { primary: workspace.rootPath, additional: [], missing: [] } : undefined);
  const send = (type: 'agent.submit' | 'agent.interrupt-and-submit') => (prompt: string, context?: ChatMessageContext): Promise<StructuredAgentUiResult> => (
    submitConversationMessage(access, { sessionId, recovery: recovery.controller, type, prompt, ...(context ? { context } : {}), onAccepted: () => onSent?.(sessionId) })
  );

  return (
    <StructuredAgentSessionPanel
      presentation="composer"
      variant={variant}
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
      queuedCount={agent.queuedTurnCount}
      queueItems={conversationQueue(sessionId, snapshot?.turns ?? [], queue.items)}
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
      sendDisabled={recovery.view.status !== 'ready' || workflow.loading}
      sendDisabledReason={recovery.view.status === 'loading' ? 'Restoring secure draft…' : recovery.view.message}
      recoveryControl={<ChatRecoveryNotice controller={recovery.controller} view={recovery.view} />}
      deliveryUncertain={recovery.view.pendingSubmit !== undefined}
      onReconcileDelivery={() => reconcileConversationSubmit(access, { recovery: recovery.controller, onAccepted: () => onSent?.(sessionId) })}
      onSend={send('agent.submit')}
      onInterruptAndSend={historyOnly ? undefined : send('agent.interrupt-and-submit')}
      onChangeSettings={historyOnly ? undefined : (settings) => changeConversationSettings(access, sessionId, settings)}
      onCancel={!historyOnly && owner === 'managed' && queue.complete ? () => runConversationLifecycle(access, sessionId, 'agent.cancel') : undefined}
      {...(onNewConversation ? { onNewConversation } : {})}
    />
  );
}
