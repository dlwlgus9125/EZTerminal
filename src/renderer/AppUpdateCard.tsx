import { AlertTriangle, Download, FolderOpen, RefreshCw } from 'lucide-react';
import { useRef, useState } from 'react';

import {
  isAppUpdateAvailable,
  type AppUpdateErrorCode,
  type AppUpdateSnapshot,
} from '../shared/app-update';
import { useAppTranslation } from './i18n';
import { Button, Dialog } from './ui';
import type { AppUpdateController } from './use-app-update';

const UPDATE_ERROR_KEY = {
  NETWORK: 'settings.update.errors.network',
  TIMEOUT: 'settings.update.errors.timeout',
  RATE_LIMITED: 'settings.update.errors.rateLimited',
  HTTP: 'settings.update.errors.http',
  INVALID_RELEASE: 'settings.update.errors.invalidRelease',
  NO_COMPATIBLE_ASSET: 'settings.update.errors.noAsset',
  STORAGE: 'settings.update.errors.storage',
  INTEGRITY_MISMATCH: 'settings.update.errors.integrity',
  PACKAGE_MISMATCH: 'settings.update.errors.package',
  SIGNER_MISMATCH: 'settings.update.errors.signer',
  OPEN_FAILED: 'settings.update.errors.open',
  INSTALL_PERMISSION_REQUIRED: 'settings.update.errors.permission',
  UNAVAILABLE: 'settings.update.errors.unavailable',
} as const satisfies Record<AppUpdateErrorCode, string>;

function formatBytes(value: number): string {
  if (value < 1_048_576) return `${Math.max(1, Math.round(value / 1_024))} KiB`;
  return `${(value / 1_048_576).toFixed(value >= 10 * 1_048_576 ? 0 : 1)} MiB`;
}

function checkedAtLabel(snapshot: AppUpdateSnapshot, locale: string): string | null {
  return snapshot.checkedAt === null
    ? null
    : new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(snapshot.checkedAt);
}

export function AppUpdateCard({
  controller,
}: {
  readonly controller: AppUpdateController;
}): JSX.Element {
  const { snapshot } = controller;
  const { i18n, t } = useAppTranslation();
  const [unsignedDialogOpen, setUnsignedDialogOpen] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const checkedAt = checkedAtLabel(snapshot, i18n.resolvedLanguage ?? 'en');
  const busy = snapshot.phase === 'checking' || snapshot.phase === 'downloading';
  const canOpen = Boolean(snapshot.download) && snapshot.phase !== 'downloading';
  const retry = snapshot.error?.stage === 'check'
    ? controller.check
    : snapshot.error?.stage === 'open'
      ? () => controller.openDownloaded(
        snapshot.download?.requiresUnsignedConfirmation === true,
      ).then(() => undefined)
      : controller.download;
  const openDownloaded = (): void => {
    if (snapshot.download?.requiresUnsignedConfirmation) {
      setUnsignedDialogOpen(true);
      return;
    }
    void controller.openDownloaded(false);
  };

  return (
    <div className="app-update-card" data-testid="app-update-card">
      <div className="app-update-card__heading">
        <div>
          <h3>{t('settings.update.title')}</h3>
          <p>{t('settings.update.currentVersion', { version: snapshot.currentVersion })}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          leadingIcon={<RefreshCw />}
          loading={snapshot.phase === 'checking'}
          loadingLabel={t('settings.update.checking')}
          disabled={snapshot.phase === 'downloading'}
          onClick={() => void controller.check()}
          data-testid="app-update-check"
        >
          {t('settings.update.checkAgain')}
        </Button>
      </div>

      {snapshot.phase === 'idle' && (
        <p className="app-update-card__status">{t('settings.update.notChecked')}</p>
      )}
      {snapshot.phase === 'checking' && (
        <p className="app-update-card__status" role="status" aria-live="polite">
          {t('settings.update.checking')}
        </p>
      )}
      {snapshot.phase === 'current' && (
        <p className="app-update-card__status" role="status">
          {t('settings.update.current')}
        </p>
      )}

      {snapshot.release && isAppUpdateAvailable(snapshot) && (
        <div className="app-update-card__release">
          <strong>{t('settings.update.available', { version: snapshot.release.version })}</strong>
          <span>{formatBytes(snapshot.release.sizeBytes)}</span>
        </div>
      )}

      {snapshot.phase === 'available' && (
        <Button
          variant="primary"
          leadingIcon={<Download />}
          onClick={() => void controller.download()}
          data-testid="app-update-download"
        >
          {t('settings.update.download')}
        </Button>
      )}

      {snapshot.phase === 'downloading' && snapshot.progress && (
        <div className="app-update-card__progress" role="status" aria-live="polite">
          <progress
            max={snapshot.progress.totalBytes}
            value={snapshot.progress.receivedBytes}
            aria-label={t('settings.update.downloading')}
          />
          <span>
            {t('settings.update.progress', {
              percent: snapshot.progress.percent,
              received: formatBytes(snapshot.progress.receivedBytes),
              total: formatBytes(snapshot.progress.totalBytes),
            })}
          </span>
          <Button size="sm" onClick={() => void controller.cancelDownload()}>
            {t('common.cancel')}
          </Button>
        </div>
      )}

      {snapshot.download && (
        <div className="app-update-card__downloaded" role="status">
          <p>{t('settings.update.downloaded', {
            name: snapshot.download.name,
            location: snapshot.download.locationLabel,
          })}</p>
          {canOpen && (
            <Button
              variant="primary"
              leadingIcon={<FolderOpen />}
              onClick={openDownloaded}
              data-testid="app-update-open"
            >
              {t('settings.update.openInstaller')}
            </Button>
          )}
        </div>
      )}

      {snapshot.phase === 'error' && snapshot.error && (
        <div className="app-update-card__error" role="alert">
          <p>{t(UPDATE_ERROR_KEY[snapshot.error.code])}</p>
          {snapshot.error.retryable && (
            <Button size="sm" disabled={busy} onClick={() => void retry()}>
              {t('common.retry')}
            </Button>
          )}
        </div>
      )}

      {checkedAt && (
        <small className="app-update-card__checked">
          {t('settings.update.checkedAt', { value: checkedAt })}
        </small>
      )}

      <Dialog
        open={unsignedDialogOpen}
        onOpenChange={setUnsignedDialogOpen}
        title={t('settings.update.unsignedTitle')}
        description={t('settings.update.unsignedDescription')}
        icon={<AlertTriangle />}
        role="alertdialog"
        tone="warning"
        size="sm"
        initialFocusRef={confirmRef}
        testId="app-update-unsigned-dialog"
        footer={(
          <>
            <Button onClick={() => setUnsignedDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              ref={confirmRef}
              variant="primary"
              onClick={() => {
                setUnsignedDialogOpen(false);
                void controller.openDownloaded(true);
              }}
              data-testid="app-update-confirm-unsigned"
            >
              {t('settings.update.openUnsigned')}
            </Button>
          </>
        )}
      >
        <p>{t('settings.update.unsignedDetail')}</p>
      </Dialog>
    </div>
  );
}
