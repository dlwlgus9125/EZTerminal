import { useEffect, useRef, useState } from 'react';
import type { DaemonLifecycleSettings } from '../shared/ipc';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { useAppTranslation } from './i18n';
import { Button, Status, Switch } from './ui';

export function LifecycleSettings({ capabilities = rendererCapabilities }: { readonly capabilities?: CapabilityAccess }): JSX.Element {
  const { t } = useAppTranslation();
  const [settings, setSettings] = useState<DaemonLifecycleSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const lock = useRef(false);
  useEffect(() => {
    let active = true;
    setError(false);
    void Promise.resolve().then(() => capabilities.daemon.getLifecycleSettings()).then((value) => {
      if (active) { setSettings(value); setError(value === null); }
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [capabilities, retry]);
  const save = async (patch: Partial<DaemonLifecycleSettings>): Promise<void> => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(false);
    try {
      const next = await capabilities.daemon.setLifecycleSettings(patch);
      if (!next) throw new Error('unavailable');
      setSettings(next);
    } catch { setError(true); }
    finally { lock.current = false; setBusy(false); }
  };
  return <section className="status-section" aria-label={t('agentSettings.keepRunning')}>
    {settings && <>
      <Switch checked={settings.keepRunning} disabled={busy} onChange={(event) => void save({ keepRunning: event.target.checked })}
        label={t('agentSettings.keepRunning')} description={t('agentSettings.keepRunningHint')} data-testid="agent-keep-running" />
      <Switch checked={settings.startAtLogin} disabled={busy || !settings.keepRunning} onChange={(event) => void save({ startAtLogin: event.target.checked })}
        label={t('agentSettings.startAtLogin')} description={t('agentSettings.startAtLoginHint')} data-testid="agent-start-at-login" />
    </>}
    {!settings && !error && <Status variant="loading">{t('agentSettings.runtimeLoading')}</Status>}
    {error && <Status variant="danger" live="polite">{t('agentSettings.lifecycleSaveFailed')} <Button variant="ghost" onClick={() => setRetry((value) => value + 1)}>{t('common.retry')}</Button></Status>}
  </section>;
}
