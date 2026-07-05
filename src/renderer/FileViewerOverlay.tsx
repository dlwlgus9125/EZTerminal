import { useEffect } from 'react';

interface FileViewerOverlayProps {
  readonly name: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly onClose: () => void;
}

/**
 * Read-only plain-text viewer overlay (file-explorer plan, M1) — no syntax
 * highlighting, no editing. z-index 90 sits above the file drawer (60) and
 * below the command palette (100); M2's context menu sits above it at 95.
 */
export function FileViewerOverlay({
  name,
  content,
  truncated,
  onClose,
}: FileViewerOverlayProps): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="file-viewer-overlay" data-testid="file-viewer-overlay">
      <div className="file-viewer-header">
        <span className="file-viewer-name">{name}</span>
        <button className="btn btn-split" onClick={onClose} title="Close" data-testid="viewer-close">
          ✕
        </button>
      </div>
      {truncated && (
        <div className="file-viewer-truncated" data-testid="viewer-truncated">
          File truncated to the first 1 MiB.
        </div>
      )}
      <pre className="file-viewer-content" data-testid="viewer-content">
        {content}
      </pre>
    </div>
  );
}
