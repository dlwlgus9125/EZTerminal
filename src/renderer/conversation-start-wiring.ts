import { useEffect, useMemo, useState } from 'react';

import type { ConversationFolders } from '../shared/conversation-folders';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import type { ChatStateAccess } from './chat-recovery';
import type { ConversationStartAccess } from './conversation-start';
import { desktopChatStateAccess } from './use-chat-recovery';

/**
 * What the production new-conversation form needs from the desktop host: the
 * daemon access, secure draft storage, capability client and each working
 * folder's folders. Shared by the conversation tab and the board's start bar.
 */
export function useConversationStartWiring(snapshot: DaemonSnapshot | null, projectId: string | undefined): {
  readonly access: ConversationStartAccess;
  readonly storage: ChatStateAccess;
  readonly capabilityClient: { readonly list: typeof window.ezterminal.agentCapabilitiesList; readonly manage: typeof window.ezterminal.agentCapabilitiesManage };
  readonly workspaceFolders?: (workspaceId: string) => ConversationFolders | undefined;
} {
  const access = useMemo<ConversationStartAccess>(() => ({ history: window.ezterminal,
    getSnapshot: () => window.ezterminal.getDaemonSnapshot(), sendCommand: command => window.ezterminal.sendDaemonCommand(command), principal: { kind: 'desktop', id: 'renderer-agent-ui' } }), []);
  // The renderer-wide storage object, so two boxes on one draft share its controller.
  const storage = desktopChatStateAccess;
  const capabilityClient = useMemo(() => ({ list: window.ezterminal.agentCapabilitiesList, manage: window.ezterminal.agentCapabilitiesManage }), []);
  // The folders each workspace of the project would bring, for the start form's folder setting.
  // Asked again whenever the project's workspaces change (folders added, removed or moved).
  const readFolders = window.ezterminalDesktop?.getConversationFolders;
  const folderTargetsKey = useMemo(() => JSON.stringify((snapshot?.workspaces ?? [])
    .filter(workspace => !workspace.archivedAt && (!projectId || workspace.projectId === projectId))
    .map(workspace => [workspace.projectId, workspace.id, workspace.rootPath])), [snapshot, projectId]);
  const [folders, setFolders] = useState<Readonly<Record<string, ConversationFolders>>>({});
  useEffect(() => {
    const targets = JSON.parse(folderTargetsKey) as readonly (readonly [string, string, string])[];
    if (!readFolders || targets.length === 0) return undefined;
    let alive = true;
    void Promise.all(targets.map(async ([targetProjectId, workspaceId]) => (
      [workspaceId, await readFolders({ projectId: targetProjectId, workspaceId }).catch(() => null)] as const
    ))).then(found => {
      if (alive) setFolders(Object.fromEntries(found.filter((pair): pair is readonly [string, ConversationFolders] => pair[1] !== null)));
    });
    return () => { alive = false; };
  }, [readFolders, folderTargetsKey]);
  return { access, storage, capabilityClient, ...(readFolders ? { workspaceFolders: (workspaceId: string) => folders[workspaceId] } : {}) };
}
