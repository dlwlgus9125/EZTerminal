import { Directory, Filesystem } from '@capacitor/filesystem';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { FileEntry } from '../../src/shared/files';
import { uint8ArrayToBase64 } from '../../src/shared/remote-protocol';
import { useLongPress } from './long-press';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';
import { createUploadQueue, type UploadItem } from './upload-queue';

// MobileFileView — full-screen file browser (file-explorer plan, M4). Modeled
// on MobileStatsView.tsx's structure (a standalone full-screen overlay with
// its own header, reusing the app's `.btn`/`--term-*` styling rather than a
// desktop-panel port). `transport` is the CONCRETE `WsEzTerminalTransport`
// instance (not just `window.ezterminal: EzTerminalApi`) because
// `downloadFile` is mobile-only and isn't part of that shared interface.
//
// Directory-level actions (Refresh/New folder) are reachable BOTH as header
// buttons (so an EMPTY directory still has a way to create a folder — a
// long-press needs a row to press) AND from any row's long-press action
// sheet (matching the plan's literal item list), which acts on the current
// directory regardless of which row triggered the sheet.
//
// `formatSize` is a small local copy of the desktop drawer's
// (FileExplorerPanel.tsx) — not shared, since sharing it would mean editing
// that file too, and this milestone's scope is mobile-only.
//
// Upload (M5): ONE `upload-queue.ts` instance lives for this component's
// whole lifetime (`uploadQueueRef`) rather than one per file-picker
// interaction, so multiple picks in a row still process strictly
// sequentially through the same queue. Its `deps.uploadFile`/`onChange`
// closures are created ONCE and read `currentPathRef` (the LIVE viewed
// directory, for the "refresh on completion" check) through a ref — the
// same "stable closure, live values via ref" idiom `MobileSessionView.tsx`
// uses for `onSessionDeadRef`/`onCwdChangeRef`. The upload TARGET directory
// is different: it's captured at `enqueue` time and travels with each
// `UploadItem` as its own `dirPath` field (see upload-queue.ts), so a second
// pick targeting a different folder while an earlier batch is still mid-
// queue can never retroactively change where that earlier batch's
// not-yet-started items upload to.

interface MobileFileViewProps {
  readonly transport: WsEzTerminalTransport;
  readonly initialPath: string;
  readonly onClose: () => void;
  readonly onOpenTerminalAt: (dirPath: string) => void;
  readonly onPastePath: (path: string) => void;
}

interface ViewingFile {
  readonly name: string;
  readonly content: string;
  readonly truncated: boolean;
}

interface DownloadProgress {
  readonly name: string;
  readonly received: number;
  readonly total: number;
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

/** Mirrors `FileExplorerPanel.tsx`'s `joinPath` — `currentPath` comes from
 * `path.resolve` on main, so its own separator tells us which one to join with. */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** Android <=29 needs a runtime grant for `Directory.Documents` (the static
 * manifest permission alone isn't enough); scoped storage (API 30+) and
 * iOS/web are no-ops that resolve 'granted' immediately. */
async function ensureFilesystemPermission(): Promise<boolean> {
  const { publicStorage } = await Filesystem.checkPermissions();
  if (publicStorage === 'granted') return true;
  const { publicStorage: after } = await Filesystem.requestPermissions();
  return after === 'granted';
}

export function MobileFileView({
  transport,
  initialPath,
  onClose,
  onOpenTerminalAt,
  onPastePath,
}: MobileFileViewProps): JSX.Element {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<readonly FileEntry[]>([]);
  const [rootsMode, setRootsMode] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [binaryNotice, setBinaryNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [viewing, setViewing] = useState<ViewingFile | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);

  const [sheetEntry, setSheetEntry] = useState<FileEntry | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingEntry, setRenamingEntry] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ name: string; fullPath: string } | null>(null);

  // Upload (M5) — see the module doc above for the ref-vs-closure shape.
  const [uploadItems, setUploadItems] = useState<readonly UploadItem[]>([]);
  const currentPathRef = useRef<string | null>(null);
  const prevUploadItemsRef = useRef<readonly UploadItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((msg: string): void => {
    setToast(msg);
    setTimeout(() => setToast((current) => (current === msg ? null : current)), 1500);
  }, []);

  const loadPath = useCallback(async (path: string): Promise<void> => {
    setBinaryNotice(null);
    const result = await transport.listFiles(path);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setRootsMode(false);
    setCurrentPath(result.path);
    currentPathRef.current = result.path;
    setParent(result.parent);
    setEntries(result.entries);
    setPathInput(result.path);
    // e2e marker (M6 parity): logcat has no DOM access without Appium.
    console.log('[ez-e2e] files:listed', result.path, result.entries.length);
  }, [transport]);

  const loadRoots = useCallback(async (): Promise<void> => {
    setBinaryNotice(null);
    const roots = await transport.listFileRoots();
    setError(null);
    setRootsMode(true);
    setCurrentPath(null);
    currentPathRef.current = null;
    setParent(null);
    setPathInput('');
    setEntries(roots.map((name) => ({ name, kind: 'dir' as const, isSymlink: false, size: 0, mtimeMs: 0 })));
    console.log('[ez-e2e] files:listed', '(roots)', roots.length);
  }, [transport]);

  // Best-effort snapshot ONLY at open — no live cwd following (locked requirement).
  useEffect(() => {
    void loadPath(initialPath);
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
      const result = await transport.readTextFile(fullPath);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (!result.isText) {
        setBinaryNotice(`${entry.name} is a binary file`);
        return;
      }
      setViewing({ name: entry.name, content: result.content, truncated: result.truncated });
      console.log('[ez-e2e] files:viewer-open', entry.name);
    },
    [transport, fullPathFor, loadPath],
  );

  const handleUp = useCallback(() => {
    if (parent !== null) {
      void loadPath(parent);
    } else if (!rootsMode) {
      void loadRoots();
    }
  }, [parent, rootsMode, loadPath, loadRoots]);

  const handleRefresh = useCallback((): void => {
    if (currentPath !== null) void loadPath(currentPath);
  }, [currentPath, loadPath]);

  const handleCopy = useCallback(
    (text: string): void => {
      navigator.clipboard.writeText(text).then(
        () => showToast('Copied'),
        () => showToast('Copy failed'),
      );
    },
    [showToast],
  );

  const startNewFolder = useCallback((): void => {
    setNewFolderName('');
    setCreatingFolder(true);
  }, []);

  const submitNewFolder = useCallback(async (): Promise<void> => {
    if (currentPath === null) return;
    const name = newFolderName.trim();
    if (!name) return;
    const result = await transport.createFolder(currentPath, name);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCreatingFolder(false);
    setNewFolderName('');
    setError(null);
    await loadPath(currentPath);
  }, [transport, currentPath, newFolderName, loadPath]);

  const startRename = useCallback((entry: FileEntry): void => {
    setRenameValue(entry.name);
    setRenamingEntry(entry.name);
  }, []);

  const submitRename = useCallback(
    async (entry: FileEntry): Promise<void> => {
      if (currentPath === null) return;
      const name = renameValue.trim();
      if (!name) return;
      const result = await transport.renameFile(fullPathFor(entry), name);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRenamingEntry(null);
      setError(null);
      await loadPath(currentPath);
    },
    [transport, currentPath, renameValue, fullPathFor, loadPath],
  );

  const requestDelete = useCallback(
    (entry: FileEntry): void => {
      setDeleteTarget({ name: entry.name, fullPath: fullPathFor(entry) });
    },
    [fullPathFor],
  );

  const confirmDelete = useCallback(async (): Promise<void> => {
    if (!deleteTarget) return;
    const result = await transport.trashFile(deleteTarget.fullPath);
    setDeleteTarget(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (currentPath !== null) await loadPath(currentPath);
  }, [transport, deleteTarget, currentPath, loadPath]);

  const handleDownload = useCallback(
    async (entry: FileEntry): Promise<void> => {
      const fullPath = fullPathFor(entry);
      setDownloadProgress({ name: entry.name, received: 0, total: entry.size });
      try {
        const granted = await ensureFilesystemPermission();
        if (!granted) {
          showToast('Storage permission denied');
          return;
        }
        const { name, bytes } = await transport.downloadFile(fullPath, (received, total) => {
          setDownloadProgress({ name: entry.name, received, total });
        });
        await Filesystem.writeFile({
          path: name,
          data: uint8ArrayToBase64(bytes),
          directory: Directory.Documents,
          recursive: true,
        });
        console.log('[ez-e2e] files:download-done', name, bytes.length);
        showToast(`Saved ${name}`);
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Download failed');
      } finally {
        setDownloadProgress(null);
      }
    },
    [transport, fullPathFor, showToast],
  );

  // ── Upload (M5) ────────────────────────────────────────────────────────────
  // See the module doc for why `deps.uploadFile`/`onChange` are created ONCE
  // and read the live viewed-directory through a ref rather than being
  // recreated per render. The upload TARGET directory, in contrast, is not a
  // ref at all — it travels with each `UploadItem` as its own `dirPath`
  // (captured at `enqueue` time), which is what makes an overlapping second
  // batch to a different folder safe (see upload-queue.ts).
  const uploadQueueRef = useRef<ReturnType<typeof createUploadQueue> | null>(null);
  if (!uploadQueueRef.current) {
    uploadQueueRef.current = createUploadQueue({
      uploadFile: (dirPath, name, bytes, onProgress) => transport.uploadFile(dirPath, name, bytes, onProgress),
      onChange: (nextItems) => {
        const prevItems = prevUploadItemsRef.current;
        for (const item of nextItems) {
          const wasDone = prevItems.find((p) => p.id === item.id)?.status === 'done';
          if (item.status === 'done' && !wasDone) {
            console.log('[ez-e2e] files:upload-done', item.finalName, item.size);
            if (item.dirPath === currentPathRef.current) {
              void loadPath(currentPathRef.current);
            }
          }
        }
        prevUploadItemsRef.current = nextItems;
        setUploadItems(nextItems);
      },
    });
  }

  const handleFilesPicked = useCallback(
    async (fileList: FileList): Promise<void> => {
      if (currentPath === null) return;
      const dirPath = currentPath; // captured AT ENQUEUE TIME
      const files = await Promise.all(
        Array.from(fileList).map(async (file) => ({
          name: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
        })),
      );
      uploadQueueRef.current?.enqueue(files, dirPath);
    },
    [currentPath],
  );

  // ── Long-press action sheet ────────────────────────────────────────────────
  // `useLongPress` only reports (x, y); which row fired is tracked separately
  // (set right before delegating to the hook's onPointerDown) since calling a
  // hook per-row inside `.map()` would violate the rules of hooks once the
  // row count changes (rename/delete/new-folder all change it).
  const pressedEntryRef = useRef<FileEntry | null>(null);
  const longPress = useLongPress(() => {
    if (pressedEntryRef.current) setSheetEntry(pressedEntryRef.current);
  });

  if (viewing) {
    return (
      <div className="mobile-file-viewer" data-testid="mobile-file-viewer">
        <header className="mobile-file-head">
          <button type="button" className="btn" onClick={() => setViewing(null)} data-testid="viewer-back">
            ‹ Back
          </button>
          <div className="mobile-file-viewer-title">{viewing.name}</div>
        </header>
        {viewing.truncated && (
          <div className="mobile-file-truncated" data-testid="viewer-truncated">
            File truncated to the first 1 MiB.
          </div>
        )}
        <pre className="mobile-file-viewer-content" data-testid="viewer-content">
          {viewing.content}
        </pre>
      </div>
    );
  }

  return (
    <div className="mobile-file-view" data-testid="mobile-file-view">
      <header className="mobile-file-head">
        <button
          type="button"
          className="btn"
          onClick={handleUp}
          disabled={rootsMode}
          aria-label="Up"
          data-testid="mobile-file-up"
        >
          ↑
        </button>
        <input
          className="mobile-file-path-input"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void loadPath(pathInput);
          }}
          aria-label="current folder path"
          data-testid="mobile-file-path-input"
        />
        <button
          type="button"
          className="btn"
          onClick={handleRefresh}
          aria-label="Refresh"
          data-testid="mobile-file-refresh"
        >
          ⟳
        </button>
        <button
          type="button"
          className="btn"
          onClick={startNewFolder}
          aria-label="New folder"
          data-testid="mobile-file-new-folder-btn"
        >
          ＋
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={currentPath === null}
          aria-label="Upload"
          data-testid="mobile-file-upload-btn"
        >
          ⇧
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="mobile-file-hidden-input"
          onChange={(e) => {
            const { files } = e.target;
            if (files && files.length > 0) void handleFilesPicked(files);
            e.target.value = ''; // allow re-picking the same file(s) again
          }}
          data-testid="mobile-file-upload-input"
        />
        <button type="button" className="btn" onClick={onClose} aria-label="Close" data-testid="mobile-file-close">
          ✕
        </button>
      </header>

      {error && (
        <div className="mobile-file-error" data-testid="mobile-file-error">
          {error}
        </div>
      )}
      {binaryNotice && (
        <div className="mobile-file-notice" data-testid="mobile-file-binary-notice">
          {binaryNotice}
        </div>
      )}
      {toast && (
        <div className="mobile-file-toast" data-testid="mobile-file-toast">
          {toast}
        </div>
      )}
      {downloadProgress && (
        <div className="mobile-file-progress" data-testid="mobile-file-progress">
          {downloadProgress.name}: {formatSize(downloadProgress.received)} / {formatSize(downloadProgress.total)}
        </div>
      )}
      {uploadItems.length > 0 && (
        <div className="mobile-upload-list" data-testid="mobile-upload-list">
          {uploadItems.map((item) => (
            <div key={item.id} className="mobile-upload-row" data-testid="mobile-upload-item">
              {/* Surfaces a server-side collision auto-rename ("report (1).txt") once done. */}
              <span className="mobile-upload-name">{item.status === 'done' ? item.finalName : item.name}</span>
              {item.status === 'pending' && <span className="mobile-upload-status">Waiting…</span>}
              {item.status === 'uploading' && (
                <span className="mobile-upload-status">
                  {formatSize(item.receivedBytes)} / {formatSize(item.size)}
                </span>
              )}
              {item.status === 'done' && (
                <span className="mobile-upload-status mobile-upload-status--done">Done</span>
              )}
              {item.status === 'failed' && (
                <span className="mobile-upload-status mobile-upload-status--failed">{item.error}</span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mobile-file-list" data-testid="mobile-file-list" onScroll={longPress.onScroll}>
        {creatingFolder && (
          <div className="mobile-file-row">
            <input
              className="mobile-file-path-input"
              value={newFolderName}
              autoFocus
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitNewFolder();
                else if (e.key === 'Escape') setCreatingFolder(false);
              }}
              data-testid="mobile-new-folder-input"
            />
          </div>
        )}
        {entries.map((entry) =>
          renamingEntry === entry.name ? (
            <div key={entry.name} className="mobile-file-row" data-testid="mobile-file-entry">
              <input
                className="mobile-file-path-input"
                value={renameValue}
                autoFocus
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitRename(entry);
                  else if (e.key === 'Escape') setRenamingEntry(null);
                }}
                data-testid="mobile-rename-input"
              />
            </div>
          ) : (
            <div
              key={entry.name}
              className="mobile-file-row"
              data-testid="mobile-file-entry"
              onClick={() => void openEntry(entry)}
              onPointerDown={(e) => {
                pressedEntryRef.current = entry;
                longPress.onPointerDown(e);
              }}
              onPointerMove={longPress.onPointerMove}
              onPointerUp={longPress.onPointerUp}
              onPointerCancel={longPress.onPointerCancel}
              onContextMenu={longPress.onContextMenu}
            >
              <span className="mobile-file-icon" aria-hidden="true">
                {entry.kind === 'dir' ? '▸' : '▪'}
              </span>
              <span className="mobile-file-name">{entry.name}</span>
              {entry.kind === 'file' && <span className="mobile-file-size">{formatSize(entry.size)}</span>}
            </div>
          ),
        )}
      </div>

      {sheetEntry && (
        <div
          className="mobile-file-sheet-backdrop"
          data-testid="mobile-file-sheet-backdrop"
          onClick={() => setSheetEntry(null)}
        >
          <div className="mobile-file-sheet" data-testid="mobile-file-sheet" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="mobile-file-sheet-item"
              onClick={() => {
                handleCopy(fullPathFor(sheetEntry));
                setSheetEntry(null);
              }}
              data-testid="sheet-copy-path"
            >
              Copy path
            </button>
            <button
              type="button"
              className="mobile-file-sheet-item"
              onClick={() => {
                handleCopy(sheetEntry.name);
                setSheetEntry(null);
              }}
              data-testid="sheet-copy-name"
            >
              Copy name
            </button>
            <button
              type="button"
              className="mobile-file-sheet-item"
              onClick={() => {
                handleRefresh();
                setSheetEntry(null);
              }}
              data-testid="sheet-refresh"
            >
              Refresh
            </button>
            <button
              type="button"
              className="mobile-file-sheet-item"
              onClick={() => {
                startNewFolder();
                setSheetEntry(null);
              }}
              data-testid="sheet-new-folder"
            >
              New folder
            </button>
            <button
              type="button"
              className="mobile-file-sheet-item"
              onClick={() => {
                startRename(sheetEntry);
                setSheetEntry(null);
              }}
              data-testid="sheet-rename"
            >
              Rename
            </button>
            <button
              type="button"
              className="mobile-file-sheet-item"
              onClick={() => {
                requestDelete(sheetEntry);
                setSheetEntry(null);
              }}
              data-testid="sheet-delete"
            >
              Delete
            </button>
            {sheetEntry.kind === 'dir' && (
              <button
                type="button"
                className="mobile-file-sheet-item"
                onClick={() => {
                  onOpenTerminalAt(fullPathFor(sheetEntry));
                  setSheetEntry(null);
                }}
                data-testid="sheet-open-terminal"
              >
                Open terminal here
              </button>
            )}
            <button
              type="button"
              className="mobile-file-sheet-item"
              onClick={() => {
                onPastePath(fullPathFor(sheetEntry));
                setSheetEntry(null);
              }}
              data-testid="sheet-paste-path"
            >
              Paste path into input
            </button>
            {sheetEntry.kind === 'file' && (
              <button
                type="button"
                className="mobile-file-sheet-item"
                onClick={() => {
                  void handleDownload(sheetEntry);
                  setSheetEntry(null);
                }}
                data-testid="sheet-download"
              >
                Download to phone
              </button>
            )}
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="mobile-file-sheet-backdrop" data-testid="mobile-delete-confirm">
          <div className="mobile-file-confirm-box">
            <p>Move {deleteTarget.name} to trash?</p>
            <div className="mobile-file-confirm-actions">
              <button
                type="button"
                className="btn"
                onClick={() => void confirmDelete()}
                data-testid="delete-confirm-yes"
              >
                Delete
              </button>
              <button
                type="button"
                className="btn"
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
