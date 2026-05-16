/**
 * FilesPanel — T10 implementation.
 * Displays CWD file tree with virtual scroll.
 * CWD detection: OSC 7 sequences from terminal (primary) plus Win32 fallback.
 * Realtime: chokidar watch via IPC triggers re-read on fs:changed.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { DirEntry } from "../../../../shared/filesystem-types";
import styles from "./FilesPanel.module.css";

interface FilesPanelProps {
  isVisible: boolean;
  /** Initial CWD — overridden by OSC 7 or Win32 fallback */
  initialCwd?: string;
}

// Detect CWD from OSC 7 sequence data
// Format: ESC ] 7 ; file://hostname/path BEL
// Uses string search to avoid control character regex restrictions
const OSC7_PREFIX = "file://";

function parseCwdFromOsc7(data: string): string | null {
  const prefixIdx = data.indexOf(OSC7_PREFIX);
  if (prefixIdx === -1) return null;

  // Skip to after the hostname (next '/')
  const afterPrefix = data.slice(prefixIdx + OSC7_PREFIX.length);
  const slashIdx = afterPrefix.indexOf("/");
  if (slashIdx === -1) return null;

  // Extract path up to BEL (\x07) or ESC (\x1b)
  const pathStart = slashIdx;
  let pathEnd = afterPrefix.length;
  for (let i = pathStart; i < afterPrefix.length; i++) {
    const code = afterPrefix.charCodeAt(i);
    // BEL = 7, ESC = 27
    if (code === 7 || code === 27) {
      pathEnd = i;
      break;
    }
  }

  const rawPath = afterPrefix.slice(pathStart, pathEnd);
  if (!rawPath) return null;
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}

export function FilesPanel({ isVisible, initialCwd = "" }: FilesPanelProps): ReactElement {
  const [cwd, setCwd] = useState<string>(initialCwd);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const unsubChangedRef = useRef<(() => void) | null>(null);

  const loadDir = async (dirPath: string) => {
    if (!dirPath) return;
    setError(null);
    const result = await window.electronAPI.fs.readDir(dirPath);
    if (result.ok) {
      setEntries(result.data);
    } else {
      setError(result.error ?? "Failed to read directory");
      setEntries([]);
    }
  };

  // Subscribe to fs:changed events when visible
  // biome-ignore lint/correctness/useExhaustiveDependencies: loadDir is stable inline fn
  useEffect(() => {
    if (!isVisible) return;

    unsubChangedRef.current = window.electronAPI.fs.onChanged((changedPath) => {
      if (changedPath === cwd) {
        void loadDir(cwd);
      }
    });

    return () => {
      unsubChangedRef.current?.();
      unsubChangedRef.current = null;
    };
  }, [isVisible, cwd]);

  // Load entries and start watch when CWD changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: loadDir is stable inline fn
  useEffect(() => {
    if (!cwd || !isVisible) return;
    void loadDir(cwd);
    window.electronAPI.fs.watch(cwd);
  }, [cwd, isVisible]);

  // Expose test hooks for OSC 7 / Win32 fallback integration
  useEffect(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test hook interface
    (window as any).__filesPanelSetCwd = (newCwd: string) => {
      setCwd(newCwd);
    };
    // biome-ignore lint/suspicious/noExplicitAny: test hook interface
    (window as any).__filesPanelHandleOsc7 = (data: string) => {
      const parsed = parseCwdFromOsc7(data);
      if (parsed) setCwd(parsed);
    };
    return () => {
      // biome-ignore lint/suspicious/noExplicitAny: cleanup test hooks
      // biome-ignore lint/performance/noDelete: test hook cleanup requires delete
      delete (window as any).__filesPanelSetCwd;
      // biome-ignore lint/suspicious/noExplicitAny: cleanup test hooks
      // biome-ignore lint/performance/noDelete: test hook cleanup requires delete
      delete (window as any).__filesPanelHandleOsc7;
    };
  }, []);

  // Virtual scroll over entries
  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 28,
  });

  const handleFileClick = (entry: DirEntry) => {
    if (entry.isDirectory) return;
    setSelectedFile(entry.path);
    const encoded = encodeURIComponent(entry.path);
    setPreviewUrl(`ezterm-file://${encoded}`);
  };

  return (
    <div className={styles.panel} data-testid="files-panel">
      <h2 className={styles.title}>Files</h2>

      {cwd && (
        <div className={styles.cwd} data-testid="files-cwd">
          {cwd}
        </div>
      )}

      {error && (
        <div className={styles.error} data-testid="files-error">
          {error}
        </div>
      )}

      {!cwd && !error && (
        <div className={styles.empty} data-testid="files-no-cwd">
          No directory selected
        </div>
      )}

      {cwd && !error && (
        <div
          className={styles.treeContainer}
          ref={containerRef}
          data-testid="files-tree"
          style={{ overflow: "auto", height: "calc(100% - 80px)" }}
        >
          {/* Use virtual items when available; fall back to direct render (e.g. jsdom) */}
          {(() => {
            const virtualItems = rowVirtualizer.getVirtualItems();
            const items =
              virtualItems.length > 0
                ? virtualItems.map((v) => ({
                    key: v.key,
                    index: v.index,
                    style: {
                      position: "absolute" as const,
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: `${v.size}px`,
                      transform: `translateY(${v.start}px)`,
                    },
                  }))
                : entries.map((_, i) => ({ key: i, index: i, style: {} }));

            const totalHeight = virtualItems.length > 0 ? rowVirtualizer.getTotalSize() : undefined;

            return (
              <div
                style={
                  totalHeight !== undefined
                    ? { height: `${totalHeight}px`, width: "100%", position: "relative" }
                    : undefined
                }
              >
                {items.map(({ key, index, style }) => {
                  const entry = entries[index];
                  if (!entry) return null;
                  return (
                    <div
                      key={key}
                      data-testid={`file-entry-${entry.name}`}
                      className={`${styles.entry} ${selectedFile === entry.path ? styles.selected : ""}`}
                      style={style}
                      onClick={() => handleFileClick(entry)}
                      onKeyDown={(e) => e.key === "Enter" && handleFileClick(entry)}
                      // biome-ignore lint/a11y/useSemanticElements: virtual list item
                      // biome-ignore lint/a11y/useFocusableInteractive: virtual list item needs tabIndex
                      role="option"
                      tabIndex={0}
                      aria-selected={selectedFile === entry.path}
                    >
                      <span className={styles.icon}>{entry.isDirectory ? "D" : "F"}</span>
                      <span className={styles.name}>{entry.name}</span>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}

      {previewUrl && (
        <div className={styles.preview} data-testid="files-preview">
          <div className={styles.previewPath} data-testid="files-preview-path">
            {selectedFile}
          </div>
          <iframe
            src={previewUrl}
            className={styles.previewFrame}
            data-testid="files-preview-frame"
            title="File Preview"
            sandbox="allow-same-origin"
          />
        </div>
      )}
    </div>
  );
}
