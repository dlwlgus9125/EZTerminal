import { useCallback, useEffect, useRef, useState } from 'react';

import { formatSize, joinPath, type FileEntry } from '../shared/files';
import { FileContextMenu, type FileContextMenuItem } from './FileContextMenu';
import { FileViewerOverlay } from './FileViewerOverlay';
import { getPaneCwd, insertIntoPaneInput } from './pane-registry';

interface FileExplorerPanelProps {
  readonly activePanelId: string | null | undefined;
  readonly onClose: () => void;
  /** Open a new terminal pane whose session starts in `dirPath` (M2 — "open terminal here"). */
  readonly onOpenTerminalAt: (dirPath: string) => void;
}

interface ViewingFile {
  readonly name: string;
  readonly content: string;
  readonly truncated: boolean;
}

interface ContextMenuState {
  readonly x: number;
  readonly y: number;
  /** `null` = the list background (current-dir-level actions), not a specific row. */
  readonly entry: FileEntry | null;
}

/**
 * Left-edge file-explorer drawer (file-explorer plan, M1/M2) — mirrors
 * StatusPanel/ConnectionInfoPanel's overlay shape but anchored left, and its
 * own toggle slot (not the stats/pairing right-side mutual exclusion).
 * Opens a BEST-EFFORT snapshot of the active pane's cwd (via pane-registry)
 * and never follows it afterward (locked requirement) — free navigation
 * (Up / drive roots / path bar) from there is otherwise unrestricted.
 * Sorting/dotfile visibility come entirely from `FileService` — never
 * re-sorted or filtered client-side here.
 *
 * M2 adds a custom right-click context menu (`FileContextMenu`, not Electron's
 * native `Menu`) driving copy/rename/delete/new-folder/open-terminal/paste-path
 * — all mutations go through `FileService` via IPC and simply `loadPath`
 * (re-list) the current directory on success; there is no client-side cache
 * to reconcile.
 */
export function FileExplorerPanel({
  activePanelId,
  onClose,
  onOpenTerminalAt,
}: FileExplorerPanelProps): JSX.Element {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<readonly FileEntry[]>([]);
  const [rootsMode, setRootsMode] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [binaryNotice, setBinaryNotice] = useState<string | null>(null);
  const [viewing, setViewing] = useState<ViewingFile | null>(null);

  // ── M2: context menu + mutations ──────────────────────────────────────────
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingEntry, setRenamingEntry] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ name: string; fullPath: string } | null>(null);
  // M6 hardening: a rapid double-click/double-Enter before a mutation's
  // response arrives could fire it twice (e.g. two trashFile calls for the
  // same path — the second fails confusingly once the first already
  // succeeded). One shared ref covers all three mutations below since they
  // never legitimately overlap; a plain ref (not state) is enough since this
  // only needs to block a second call, not drive any visible UI.
  const mutatingRef = useRef(false);

  const loadPath = useCallback(async (path: string): Promise<void> => {
    setBinaryNotice(null);
    const result = await window.ezterminal.listFiles(path);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setRootsMode(false);
    setCurrentPath(result.path);
    setParent(result.parent);
    setEntries(result.entries);
    setPathInput(result.path);
  }, []);

  const loadRoots = useCallback(async (): Promise<void> => {
    setBinaryNotice(null);
    const roots = await window.ezterminal.listFileRoots();
    setError(null);
    setRootsMode(true);
    setCurrentPath(null);
    setParent(null);
    setPathInput('');
    setEntries(
      roots.map((name) => ({ name, kind: 'dir' as const, isSymlink: false, size: 0, mtimeMs: 0 })),
    );
  }, []);

  // Best-effort snapshot ONLY at open — no live cwd following (locked requirement).
  useEffect(() => {
    void loadPath(getPaneCwd(activePanelId ?? '') ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fullPathFor = useCallback(
    (entry: FileEntry): string =>
      rootsMode || currentPath === null ? entry.name : joinPath(currentPath, entry.name),
    [rootsMode, currentPath],
  );

  const openEntry = useCallback(
    async (entry: FileEntry): Promise<void> => {
      const fullPath = fullPathFor(entry);
      if (entry.kind === 'dir') {
        await loadPath(fullPath);
        return;
      }
      setBinaryNotice(null);
      const result = await window.ezterminal.readTextFile(fullPath);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (!result.isText) {
        setBinaryNotice(`${entry.name} is a binary file`);
        return;
      }
      setViewing({ name: entry.name, content: result.content, truncated: result.truncated });
    },
    [fullPathFor, loadPath],
  );

  const handleUp = useCallback(() => {
    if (parent !== null) {
      void loadPath(parent);
    } else if (!rootsMode) {
      void loadRoots();
    }
  }, [parent, rootsMode, loadPath, loadRoots]);

  // ── M2 action handlers ────────────────────────────────────────────────────

  const showToast = useCallback((msg: string): void => {
    setToast(msg);
    setTimeout(() => setToast((current) => (current === msg ? null : current)), 1500);
  }, []);

  const handleCopy = useCallback(
    (text: string): void => {
      void navigator.clipboard.writeText(text).then(() => showToast('Copied'));
    },
    [showToast],
  );

  const handlePastePath = useCallback(
    (fullPath: string): void => {
      if (!insertIntoPaneInput(activePanelId ?? '', fullPath)) showToast('No active terminal');
    },
    [activePanelId, showToast],
  );

  const handleRefresh = useCallback((): void => {
    if (currentPath !== null) void loadPath(currentPath);
  }, [currentPath, loadPath]);

  const startNewFolder = useCallback((): void => {
    setNewFolderName('');
    setCreatingFolder(true);
  }, []);

  const submitNewFolder = useCallback(async (): Promise<void> => {
    if (currentPath === null || mutatingRef.current) return;
    const name = newFolderName.trim();
    if (!name) return;
    mutatingRef.current = true;
    try {
      const result = await window.ezterminal.createFolder(currentPath, name);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCreatingFolder(false);
      setNewFolderName('');
      setError(null);
      await loadPath(currentPath);
    } finally {
      mutatingRef.current = false;
    }
  }, [currentPath, newFolderName, loadPath]);

  const startRename = useCallback((entry: FileEntry): void => {
    setRenameValue(entry.name);
    setRenamingEntry(entry.name);
  }, []);

  const submitRename = useCallback(
    async (entry: FileEntry): Promise<void> => {
      if (currentPath === null || mutatingRef.current) return;
      const name = renameValue.trim();
      if (!name) return;
      mutatingRef.current = true;
      try {
        const result = await window.ezterminal.renameFile(fullPathFor(entry), name);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setRenamingEntry(null);
        setError(null);
        await loadPath(currentPath);
      } finally {
        mutatingRef.current = false;
      }
    },
    [currentPath, renameValue, fullPathFor, loadPath],
  );

  const requestDelete = useCallback(
    (entry: FileEntry): void => {
      setDeleteTarget({ name: entry.name, fullPath: fullPathFor(entry) });
    },
    [fullPathFor],
  );

  const confirmDelete = useCallback(async (): Promise<void> => {
    if (!deleteTarget || mutatingRef.current) return;
    mutatingRef.current = true;
    try {
      const result = await window.ezterminal.trashFile(deleteTarget.fullPath);
      setDeleteTarget(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (currentPath !== null) await loadPath(currentPath);
    } finally {
      mutatingRef.current = false;
    }
  }, [deleteTarget, currentPath, loadPath]);

  /** Background (no `entry`) gets current-dir-level actions; a file/dir row
   * gets the item set the plan specifies for its kind. */
  const buildMenuItems = useCallback(
    (entry: FileEntry | null): FileContextMenuItem[] => {
      if (entry === null) {
        if (currentPath === null) return [];
        return [
          { action: 'refresh', label: 'Refresh', onSelect: handleRefresh },
          { action: 'new-folder', label: 'New folder', onSelect: startNewFolder },
          {
            action: 'open-terminal',
            label: 'Open terminal here',
            onSelect: () => onOpenTerminalAt(currentPath),
          },
          { action: 'copy-path', label: 'Copy path', onSelect: () => handleCopy(currentPath) },
        ];
      }
      const fullPath = fullPathFor(entry);
      const common: FileContextMenuItem[] = [
        { action: 'copy-path', label: 'Copy path', onSelect: () => handleCopy(fullPath) },
        { action: 'copy-name', label: 'Copy name', onSelect: () => handleCopy(entry.name) },
      ];
      if (entry.kind === 'dir') {
        return [
          ...common,
          {
            action: 'open-terminal',
            label: 'Open terminal here',
            onSelect: () => onOpenTerminalAt(fullPath),
          },
          {
            action: 'paste-path',
            label: 'Paste path into terminal',
            onSelect: () => handlePastePath(fullPath),
          },
          { action: 'rename', label: 'Rename', onSelect: () => startRename(entry) },
          { action: 'delete', label: 'Delete', onSelect: () => requestDelete(entry) },
        ];
      }
      return [
        ...common,
        {
          action: 'paste-path',
          label: 'Paste path into terminal',
          onSelect: () => handlePastePath(fullPath),
        },
        { action: 'open-app', label: 'Open in app', onSelect: () => void window.ezterminal.openFileInApp(fullPath) },
        {
          action: 'reveal',
          label: 'Reveal in explorer',
          onSelect: () => void window.ezterminal.revealFileInExplorer(fullPath),
        },
        { action: 'rename', label: 'Rename', onSelect: () => startRename(entry) },
        { action: 'delete', label: 'Delete', onSelect: () => requestDelete(entry) },
      ];
    },
    [
      currentPath,
      fullPathFor,
      handleCopy,
      handlePastePath,
      handleRefresh,
      onOpenTerminalAt,
      requestDelete,
      startNewFolder,
      startRename,
    ],
  );

  return (
    <div className="file-drawer" data-testid="file-explorer-panel">
      <div className="file-drawer-header">
        <button
          className="btn btn-split"
          onClick={handleUp}
          disabled={rootsMode}
          title="Go up"
          data-testid="file-up"
        >
          ↑
        </button>
        <input
          className="file-path-input"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void loadPath(pathInput);
          }}
          placeholder="Path…"
          aria-label="current folder path"
          data-testid="file-path-input"
        />
        <button
          className="btn btn-split"
          onClick={onClose}
          title="Close"
          data-testid="file-explorer-close"
        >
          ✕
        </button>
      </div>

      {error && (
        <div className="file-error" data-testid="file-error">
          {error}
        </div>
      )}
      {binaryNotice && (
        <div className="file-binary-notice" data-testid="file-binary-notice">
          {binaryNotice}
        </div>
      )}
      {toast && (
        <div className="file-toast" data-testid="file-toast">
          {toast}
        </div>
      )}

      <div
        className="file-list"
        data-testid="file-list"
        onContextMenu={(e) => {
          e.preventDefault();
          if (currentPath === null) return;
          setContextMenu({ x: e.clientX, y: e.clientY, entry: null });
        }}
      >
        {creatingFolder && (
          <div className="file-entry" data-testid="new-folder-row">
            <input
              className="file-path-input"
              data-testid="new-folder-input"
              value={newFolderName}
              autoFocus
              onChange={(e) => setNewFolderName(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitNewFolder();
                else if (e.key === 'Escape') setCreatingFolder(false);
              }}
            />
          </div>
        )}
        {entries.map((entry) =>
          renamingEntry === entry.name ? (
            <div key={entry.name} className="file-entry" data-testid="file-entry">
              <input
                className="file-path-input"
                data-testid="rename-input"
                value={renameValue}
                autoFocus
                onChange={(e) => setRenameValue(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitRename(entry);
                  else if (e.key === 'Escape') setRenamingEntry(null);
                }}
              />
            </div>
          ) : (
            <div
              key={entry.name}
              className="file-entry"
              data-testid="file-entry"
              onClick={() => void openEntry(entry)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setContextMenu({ x: e.clientX, y: e.clientY, entry });
              }}
            >
              <span className="file-entry-icon" aria-hidden="true">
                {entry.kind === 'dir' ? '▸' : '▪'}
              </span>
              <span className="file-entry-name">{entry.name}</span>
              {entry.kind === 'file' && (
                <span className="file-entry-size">{formatSize(entry.size)}</span>
              )}
            </div>
          ),
        )}
      </div>

      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildMenuItems(contextMenu.entry)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {viewing && (
        <FileViewerOverlay
          name={viewing.name}
          content={viewing.content}
          truncated={viewing.truncated}
          onClose={() => setViewing(null)}
        />
      )}

      {deleteTarget && (
        <div className="file-confirm-overlay" data-testid="delete-confirm">
          <div className="file-confirm-box">
            <p>Move {deleteTarget.name} to trash?</p>
            <div className="file-confirm-actions">
              <button
                className="btn btn-split"
                onClick={() => void confirmDelete()}
                data-testid="delete-confirm-yes"
              >
                Delete
              </button>
              <button
                className="btn btn-split"
                onClick={() => setDeleteTarget(null)}
                data-testid="delete-confirm-cancel"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
