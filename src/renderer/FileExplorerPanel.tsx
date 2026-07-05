import { useCallback, useEffect, useState } from 'react';

import type { FileEntry } from '../shared/files';
import { FileViewerOverlay } from './FileViewerOverlay';
import { getPaneCwd } from './pane-registry';

interface FileExplorerPanelProps {
  readonly activePanelId: string | null | undefined;
  readonly onClose: () => void;
}

interface ViewingFile {
  readonly name: string;
  readonly content: string;
  readonly truncated: boolean;
}

const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

/** `currentPath` comes from `path.resolve` on main (see `FileService`), so its
 * own separator tells us which one to join with — mirrors `format-cwd.ts`'s
 * same `includes('\\')` check. */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/**
 * Left-edge file-explorer drawer (file-explorer plan, M1) — mirrors
 * StatusPanel/ConnectionInfoPanel's overlay shape but anchored left, and its
 * own toggle slot (not the stats/pairing right-side mutual exclusion).
 * Opens a BEST-EFFORT snapshot of the active pane's cwd (via pane-registry)
 * and never follows it afterward (locked requirement) — free navigation
 * (Up / drive roots / path bar) from there is otherwise unrestricted.
 * Sorting/dotfile visibility come entirely from `FileService` — never
 * re-sorted or filtered client-side here.
 */
export function FileExplorerPanel({ activePanelId, onClose }: FileExplorerPanelProps): JSX.Element {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<readonly FileEntry[]>([]);
  const [rootsMode, setRootsMode] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [binaryNotice, setBinaryNotice] = useState<string | null>(null);
  const [viewing, setViewing] = useState<ViewingFile | null>(null);

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

  const openEntry = useCallback(
    async (entry: FileEntry): Promise<void> => {
      const fullPath =
        rootsMode || currentPath === null ? entry.name : joinPath(currentPath, entry.name);
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
    [rootsMode, currentPath, loadPath],
  );

  const handleUp = useCallback(() => {
    if (parent !== null) {
      void loadPath(parent);
    } else if (!rootsMode) {
      void loadRoots();
    }
  }, [parent, rootsMode, loadPath, loadRoots]);

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

      <div className="file-list" data-testid="file-list">
        {entries.map((entry) => (
          <div
            key={entry.name}
            className="file-entry"
            data-testid="file-entry"
            onClick={() => void openEntry(entry)}
          >
            <span className="file-entry-icon" aria-hidden="true">
              {entry.kind === 'dir' ? '▸' : '▪'}
            </span>
            <span className="file-entry-name">{entry.name}</span>
            {entry.kind === 'file' && (
              <span className="file-entry-size">{formatSize(entry.size)}</span>
            )}
          </div>
        ))}
      </div>

      {viewing && (
        <FileViewerOverlay
          name={viewing.name}
          content={viewing.content}
          truncated={viewing.truncated}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}
