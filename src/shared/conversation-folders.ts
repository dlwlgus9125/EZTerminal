/**
 * The folders one agent conversation works in: its working folder, then the
 * project's other registered folders, which the AI also reads and edits.
 */
export interface ConversationFolders {
  readonly primary: string;
  readonly additional: readonly string[];
  /** Registered folders not found on disk. They are left out of the conversation. */
  readonly missing: readonly string[];
}

/** Last path segment, for a folder's short name. */
export function conversationFolderName(folderPath: string): string {
  const trimmed = folderPath.replace(/[\\/]+$/u, '');
  return trimmed.split(/[\\/]/u).pop() || folderPath;
}
