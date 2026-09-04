import { ShieldAlert } from 'lucide-react';
import { useId } from 'react';

import type { DaemonAuthoritySafeModeAvailability } from '../shared/daemon-authority';
import { useAppTranslation } from './i18n';
import './daemon-safe-mode-notice.css';

export function DaemonSafeModeNotice({
  availability,
  showRecoveryPath = false,
  compact = false,
}: {
  readonly availability: DaemonAuthoritySafeModeAvailability;
  readonly showRecoveryPath?: boolean;
  readonly compact?: boolean;
}): JSX.Element {
  const { t } = useAppTranslation();
  const titleId = useId();
  return (
    <section
      className="daemon-safe-mode"
      data-compact={compact || undefined}
      data-testid="daemon-safe-mode"
      role="status"
      aria-live="polite"
      aria-labelledby={titleId}
    >
      <ShieldAlert aria-hidden="true" />
      <div>
        <h3 id={titleId}>{t('agentHub.daemonSafeMode.title')}</h3>
        <p>{t('agentHub.daemonSafeMode.terminalAvailable')}</p>
        <p>{t(`agentHub.daemonSafeMode.reason.${availability.initializationCode}`)}</p>
        <p>{t(`agentHub.daemonSafeMode.disposition.${availability.databaseDisposition}`)}</p>
        {availability.currentSchemaVersion !== undefined && (
          <p>
            {t('agentHub.daemonSafeMode.schema', {
              current: availability.currentSchemaVersion,
              supported: availability.supportedSchemaVersion,
            })}
          </p>
        )}
        <p className="daemon-safe-mode__action">
          {t(`agentHub.daemonSafeMode.action.${availability.initializationCode}`)}
        </p>
        {showRecoveryPath && availability.recoveryPath && (
          <p className="daemon-safe-mode__path">
            <span>{t('agentHub.daemonSafeMode.recoveryPath')}</span>
            <code>{availability.recoveryPath}</code>
          </p>
        )}
      </div>
    </section>
  );
}
