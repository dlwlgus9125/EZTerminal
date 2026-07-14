import { useCallback } from 'react';

import type { FilePreviewResult } from '../shared/file-preview';
import { FilePreviewContent } from './FilePreviewContent';
import { useAppTranslation } from './i18n';
import { Dialog } from './ui/Dialog';

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
  const { t } = useAppTranslation();
  const handleOpenChange = useCallback((open: boolean): void => {
    if (!open) onClose();
  }, [onClose]);

  const name = result.ok ? result.name : (path.split(/[/\\]/).pop() || path);
  return (
    <Dialog
      open
      onOpenChange={handleOpenChange}
      title={<span className="file-viewer-name" title={path}>{t('fileViewer.preview', { name })}</span>}
      closeLabel={t('common.close')}
      closeOnBackdrop={false}
      size="lg"
      className="rich-file-viewer"
      testId="file-viewer-overlay"
      closeButtonTestId="viewer-close"
      footer={(
        <div className="file-viewer-actions">
          <button className="btn btn-split" type="button" onClick={onInsert}>{t('fileViewer.insert')}</button>
          {onOpen && <button className="btn btn-split" type="button" onClick={onOpen}>{t('fileViewer.open')}</button>}
          {onReveal && <button className="btn btn-split" type="button" onClick={onReveal}>{t('fileViewer.reveal')}</button>}
          {!result.ok && <button className="btn btn-split" type="button" onClick={onRetry}>{t('common.retry')}</button>}
        </div>
      )}
    >
      {result.ok && result.kind === 'text' && result.truncated && (
        <div className="file-viewer-truncated" data-testid="viewer-truncated">
          {t('fileViewer.truncated')}
        </div>
      )}
      <FilePreviewContent result={result} line={line} column={column} openExternalHttpUrl={openExternalHttpUrl} />
    </Dialog>
  );
}
