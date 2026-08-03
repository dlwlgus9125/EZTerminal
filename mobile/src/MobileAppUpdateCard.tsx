import { Download, RefreshCw } from 'lucide-react';

import {
  isAppUpdateAvailable,
  type AppUpdateErrorCode,
} from '../../src/shared/app-update';
import { useAppTranslation } from '../../src/renderer/i18n';
import type { MobileAppUpdateController } from './use-mobile-app-update';

const UPDATE_ERROR_KEY = {
  NETWORK: 'settings.update.errors.network',
  TIMEOUT: 'settings.update.errors.timeout',
  RATE_LIMITED: 'settings.update.errors.rateLimited',
  HTTP: 'settings.update.errors.http',
  INVALID_RELEASE: 'settings.update.errors.invalidRelease',
  NO_COMPATIBLE_ASSET: 'settings.update.errors.noAsset',
  STORAGE: 'settings.update.errors.storage',
  INTEGRITY_MISMATCH: 'settings.update.errors.integrity',
  SIGNATURE_INVALID: 'settings.update.errors.signature',
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

export function MobileAppUpdateCard({
  controller,
}: {
  readonly controller: MobileAppUpdateController;
}): JSX.Element {
  const { snapshot } = controller;
  const { i18n, t } = useAppTranslation();
  const checkedAt = snapshot.checkedAt === null
    ? null
    : new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(snapshot.checkedAt);
  const canOpen = Boolean(snapshot.download) && snapshot.phase !== 'downloading';
  const retry = snapshot.error?.stage === 'check'
    ? controller.check
    : snapshot.error?.stage === 'open' || snapshot.error?.stage === 'permission'
      ? async () => { await controller.openDownloaded(); }
      : controller.download;

  return (
    <section className="status-section mobile-app-update-card" data-testid="mobile-app-update-card">
      <div className="mobile-app-update-card__heading">
        <div>
          <h2 className="status-section-title">{t('settings.update.title')}</h2>
          <p>{t('settings.update.currentVersion', { version: snapshot.currentVersion })}</p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => void controller.check()}
          disabled={snapshot.phase === 'checking' || snapshot.phase === 'downloading'}
          data-testid="mobile-app-update-check"
        >
          <RefreshCw aria-hidden="true" size={16} />
          {t('settings.update.checkAgain')}
        </button>
      </div>

      {snapshot.phase === 'idle' && <p>{t('settings.update.notChecked')}</p>}
      {snapshot.phase === 'checking' && (
        <p role="status" aria-live="polite">{t('settings.update.checking')}</p>
      )}
      {snapshot.phase === 'current' && <p role="status">{t('settings.update.current')}</p>}

      {snapshot.release && isAppUpdateAvailable(snapshot) && (
        <p className="mobile-app-update-card__release">
          <strong>{t('settings.update.available', { version: snapshot.release.version })}</strong>
          <span>{formatBytes(snapshot.release.sizeBytes)}</span>
        </p>
      )}

      {snapshot.phase === 'available' && (
        <button
          type="button"
          className="btn btn-run"
          onClick={() => void controller.download()}
          data-testid="mobile-app-update-download"
        >
          <Download aria-hidden="true" size={16} />
          {t('settings.update.download')}
        </button>
      )}

      {snapshot.phase === 'downloading' && snapshot.progress && (
        <div className="mobile-app-update-card__progress" role="status" aria-live="polite">
          <progress
            max={snapshot.progress.totalBytes}
            value={snapshot.progress.receivedBytes}
            aria-label={t('settings.update.downloading')}
          />
          <span>{t('settings.update.progress', {
            percent: snapshot.progress.percent,
            received: formatBytes(snapshot.progress.receivedBytes),
            total: formatBytes(snapshot.progress.totalBytes),
          })}</span>
          <button type="button" className="btn" onClick={() => void controller.cancelDownload()}>
            {t('common.cancel')}
          </button>
        </div>
      )}

      {snapshot.download && (
        <p>{t('settings.update.downloaded', {
          name: snapshot.download.name,
          location: snapshot.download.locationLabel,
        })}</p>
      )}

      {snapshot.phase === 'error' && snapshot.error && (
        <div className="mobile-app-update-card__error" role="alert">
          <p>{t(UPDATE_ERROR_KEY[snapshot.error.code])}</p>
          {snapshot.error.code === 'INSTALL_PERMISSION_REQUIRED' && (
            <p>{t('settings.update.installPermission')}</p>
          )}
          {snapshot.error.retryable && !canOpen && (
            <button type="button" className="btn" onClick={() => void retry()}>
              {t('common.retry')}
            </button>
          )}
        </div>
      )}

      {canOpen && (
        <button
          type="button"
          className="btn btn-run"
          onClick={() => void controller.openDownloaded()}
          data-testid="mobile-app-update-open"
        >
          {t('settings.update.openApk')}
        </button>
      )}

      {checkedAt && <small>{t('settings.update.checkedAt', { value: checkedAt })}</small>}
    </section>
  );
}
