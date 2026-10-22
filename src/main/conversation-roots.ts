import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { ConversationFolders } from '../shared/conversation-folders';
import type { DaemonSnapshot, DaemonWorkspace } from '../shared/daemon-protocol';
import { findActiveDaemonWorkspace } from './daemon-workspace-authority';

function pathKey(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export async function isDirectory(folderPath: string): Promise<boolean> {
  return stat(folderPath).then((entry) => entry.isDirectory(), () => false);
}

/**
 * The folders one conversation works in: its own workspace first, then the project's other
 * registered folders in their registered order, as the terminal CLI launchers pass them
 * (`ProjectWorkspaceService.resolveSessionTarget`). A worktree stands in for the folder it was
 * made from, so that folder is left out and the worktree keeps its isolation. Folders that are
 * no longer directories are reported as missing and never handed to a provider.
 *
 * Known edge: when a registered folder is itself a linked worktree, its main checkout appears
 * as a separate workspace without a source; a conversation there also gets the registered
 * worktree as an additional folder.
 */
export async function resolveConversationFolders(input: {
  readonly registeredRoots: readonly string[];
  readonly workspaceRoot: string;
  /** The registered folder a worktree workspace was made from. */
  readonly sourceRoot?: string;
}, directory: (folderPath: string) => Promise<boolean> = isDirectory): Promise<ConversationFolders> {
  const seen = new Set([pathKey(input.workspaceRoot)]);
  if (input.sourceRoot) seen.add(pathKey(input.sourceRoot));
  const candidates: string[] = [];
  for (const root of input.registeredRoots) {
    const key = pathKey(root);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(root);
  }
  const present = await Promise.all(candidates.map((root) => directory(root)));
  return {
    primary: input.workspaceRoot,
    additional: candidates.filter((_, index) => present[index]),
    missing: candidates.filter((_, index) => !present[index]),
  };
}

const MAX_ID_LENGTH = 256;

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/**
 * Validates a renderer request for a conversation's folders: an existing session, or a project
 * workspace a new conversation would start in.
 */
export function conversationFolderTarget(
  request: unknown,
  snapshot: Pick<DaemonSnapshot, 'sessions'>,
): { readonly projectId: string; readonly workspaceId: string } | undefined {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return undefined;
  const fields = request as { readonly sessionId?: unknown; readonly projectId?: unknown; readonly workspaceId?: unknown };
  if (boundedId(fields.sessionId)) {
    const session = snapshot.sessions.find((entry) => entry.id === fields.sessionId);
    return session ? { projectId: session.projectId, workspaceId: session.workspaceId } : undefined;
  }
  return boundedId(fields.projectId) && boundedId(fields.workspaceId)
    ? { projectId: fields.projectId, workspaceId: fields.workspaceId }
    : undefined;
}

export type ConversationFolderResolver = (
  snapshot: Pick<DaemonSnapshot, 'projects' | 'workspaces'>,
  target: { readonly projectId: string; readonly workspaceId: string },
) => Promise<ConversationFolders | undefined>;

/**
 * Binds the rule to the registered Project folders. `registeredRoots` answers for the daemon
 * Project id (primary folder first) and is undefined for a project without registered folders.
 */
export function createConversationFolderResolver(options: {
  readonly registeredRoots: (projectId: string) => readonly string[] | undefined;
  readonly isDirectory?: (folderPath: string) => Promise<boolean>;
}): ConversationFolderResolver {
  return async (snapshot, target) => {
    const workspace = findActiveDaemonWorkspace(snapshot, target.workspaceId, target.projectId);
    if (!workspace) return undefined;
    const source: DaemonWorkspace | undefined = workspace.sourceWorkspaceId
      ? snapshot.workspaces.find((entry) => entry.id === workspace.sourceWorkspaceId)
      : undefined;
    return resolveConversationFolders({
      registeredRoots: options.registeredRoots(workspace.projectId) ?? [],
      workspaceRoot: workspace.rootPath,
      ...(source ? { sourceRoot: source.rootPath } : {}),
    }, options.isDirectory);
  };
}
