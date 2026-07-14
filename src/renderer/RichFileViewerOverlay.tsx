import { useEffect } from 'react';

import type { FilePreviewResult } from '../shared/file-preview';
import { FilePreviewContent } from './FilePreviewContent';

export interface RichFileViewerOverlayProps {
  readonly path: string;
  readonly result: FilePreviewResult;
  readonly line?: number;
  readonly column?: number;
  readonly onClose: () => void;
  readonly onInsert: () => void;
  readonly onRetry: () => void;
  readonly onOpen?: () => void;
  readonly onReveal?: () => void;
  readonly openExternalHttpUrl?: (url: string) => void;
}

export function RichFileViewerOverlay({
  path,
  result,
  line,
  column,
  onClose,
  onInsert,
  onRetry,
  onOpen,
  onReveal,
  openExternalHttpUrl,
}: RichFileViewerOverlayProps): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const name = result.ok ? result.name : (path.split(/[/\\]/).pop() || path);
  return (
    <div className="file-viewer-overlay rich-file-viewer" data-testid="file-viewer-overlay" role="dialog" aria-label={`Preview ${name}`}>
      <div className="file-viewer-header">
        <span className="file-viewer-name" title={path}>{name}</span>
        <div className="file-viewer-actions">
          <button className="btn btn-split" type="button" onClick={onInsert}>Insert</button>
          {onOpen && <button className="btn btn-split" type="button" onClick={onOpen}>Open</button>}
          {onReveal && <button className="btn btn-split" type="button" onClick={onReveal}>Reveal</button>}
          {!result.ok && <button className="btn btn-split" type="button" onClick={onRetry}>Retry</button>}
          <button className="btn btn-split" type="button" onClick={onClose} title="Close" data-testid="viewer-close">
            Close
          </button>
        </div>
      </div>
      {result.ok && result.kind === 'text' && result.truncated && (
        <div className="file-viewer-truncated" data-testid="viewer-truncated">
          File truncated to the first 1 MiB.
        </div>
      )}
      <FilePreviewContent result={result} line={line} column={column} openExternalHttpUrl={openExternalHttpUrl} />
    </div>
  );
}
