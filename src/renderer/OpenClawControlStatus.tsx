import type { OpenClawControlSnapshot, OpenClawStatus } from '../shared/openclaw';
import { useAppTranslation } from './i18n';

/** Both clients present execution and the optional management connection separately. */
export function OpenClawConnectionStatus({ status }: { readonly status: OpenClawStatus | null }): JSX.Element | null {
  const { t } = useAppTranslation();
  if (status?.state !== 'running' || !status.connectionState || status.connectionState === 'connected') return null;
  return (
    <div className="status-metric" role="status" data-testid="openclaw-connection-status">
      {t(`openClaw.connection.${status.connectionState}`)}
    </div>
  );
}

export function OpenClawControlStatus({ control, testId }: {
  readonly control: OpenClawControlSnapshot;
  readonly testId: string;
}): JSX.Element {
  const { t } = useAppTranslation();
  const operation = control.operation;
  const legacyMaintenance = operation && ['diagnosing', 'backing-up', 'repairing', 'verifying'].includes(operation.phase);
  const phase = legacyMaintenance ? 'starting' : operation?.phase ?? 'idle';
  return (
    <section className="status-section openclaw-control-card" data-testid={testId} data-phase={operation?.phase ?? 'idle'}>
      <div aria-live="polite">
        <div className="status-metric">
          {t(control.supervisorState === 'ready'
            ? `openClaw.login.${control.desiredState}` : 'openClaw.login.unavailable')}
        </div>
        {operation && phase !== 'blocked' && (
          <div className="openclaw-control-progress" role="status">{t(`openClaw.phase.${phase}`)}</div>
        )}
        {control.issue && (
          <div className="openclaw-control-issue" role="alert" data-testid="openclaw-control-issue">
            <strong>{control.issue.detail.split(/\r?\n/u)[0].slice(0, 240)}</strong>
            <span>{t('openClaw.retryGuide')}</span>
          </div>
        )}
      </div>
      <details className="openclaw-control-details">
        <summary>{t('openClaw.executionDetails')}</summary>
        <div className="openclaw-control-grid">
          <span>{t('openClaw.supervisor')}</span>
          <strong>{t(`openClaw.supervisorState.${control.supervisorState}`)}</strong>
          <span>{t('openClaw.desiredState')}</span>
          <strong>{t(`openClaw.desired.${control.desiredState}`)}</strong>
        </div>
        {operation && operation.attempt > 0 && (
          <div>{t('openClaw.attempt', { attempt: operation.attempt, max: operation.maxAttempts })}</div>
        )}
        {control.issue && (
          <div className="openclaw-control-issue">
            <pre>{control.issue.detail}</pre>
            <span>{control.issue.remediation}</span>
            <code>{control.issue.diagnosticId}</code>
          </div>
        )}
        <p>{t('openClaw.manualRepairGuide')}</p>
        <code>openclaw doctor --fix</code>
      </details>
    </section>
  );
}
