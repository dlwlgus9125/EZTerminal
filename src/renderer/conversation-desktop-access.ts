/**
 * Desktop bridges a conversation's message box uses wherever it is shown (its
 * tab, a terminal's AI input): `@` file search in the session's workspace and
 * the path of a file dropped on the box.
 */

/** Electron's File -> absolute path bridge, for files dropped on the composer. */
export function pathForDrop(file: File): string | null {
  try {
    return window.ezterminalDesktop?.getPathForFile(file) ?? null;
  } catch {
    return null;
  }
}

let mentionSearchSequence = 0;
/** One stable function per root: the composer re-runs its search whenever the function changes. */
const mentionSearches = new Map<string, (query: string) => Promise<readonly string[]>>();

/** `@` mentions search the session's workspace with the Quick Open file index. */
export function desktopFileSearch(root: string | undefined): ((query: string) => Promise<readonly string[]>) | undefined {
  const desktop = window.ezterminalDesktop;
  if (!root || typeof desktop?.searchWorkspaceFiles !== 'function') return undefined;
  const existing = mentionSearches.get(root);
  if (existing) return existing;
  const search = async (query: string): Promise<readonly string[]> => {
    if (!query.trim()) return [];
    mentionSearchSequence += 1;
    const result = await desktop.searchWorkspaceFiles({ requestId: `agent-mention-${mentionSearchSequence}`, root, query });
    return result.ok ? result.matches.map((match) => match.relativePath.replace(/\\/gu, '/')) : [];
  };
  mentionSearches.set(root, search);
  return search;
}
