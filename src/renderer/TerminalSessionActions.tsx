import { useRef, useState } from 'react';
import type { EzTerminalApi } from '../shared/ipc';
import { sameActiveRunSet } from '../shared/close-risk';
import { useAppTranslation } from './i18n';
import { Button, Dialog } from './ui';

/** Ending a session is independent of which device owns an open view. */
export function TerminalSessionActions({ sessionId, title, access }: {
  readonly sessionId: string;
  readonly title: string;
  readonly access: Pick<EzTerminalApi, 'listRuns' | 'terminateSessionGuarded'>;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [runs, setRuns] = useState<readonly string[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const latestRuns = async () => (await access.listRuns()).filter((run) => run.sessionId === sessionId).map((run) => run.runId);
  const prepare = async (): Promise<void> => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(false);
    try { setRuns(await latestRuns()); } catch { setError(true); }
    finally { lock.current = false; setBusy(false); }
  };
  const terminate = async (): Promise<void> => {
    if (lock.current || runs === null) return;
    lock.current = true; setBusy(true); setError(false);
    try {
      const current = await latestRuns();
      if (!sameActiveRunSet(current, runs)) { setRuns(current); setError(true); return; }
      const result = await access.terminateSessionGuarded(sessionId, current);
      if (result.ok) setRuns(null);
      else { setError(true); setRuns(await latestRuns()); }
    } catch { setError(true); }
    finally { lock.current = false; setBusy(false); }
  };
  return <>
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void prepare()} aria-label={`${t('sessionNavigation.end')}: ${title}`} data-testid="session-end">{t('sessionNavigation.end')}</Button>
    {error && runs === null && <p role="alert">{t('safetyDialog.terminalStateUnavailableDescription')}</p>}
    <Dialog open={runs !== null} onOpenChange={(open) => { if (!open && !busy) setRuns(null); }} role="alertdialog" tone="danger"
      title={`${t('sessionNavigation.end')}: ${title}`} description={t('sessionNavigation.endDescription')}
      initialFocusRef={cancelRef} closeLabel={t('common.cancel')} testId="session-end-dialog"
      footer={<><Button ref={cancelRef} disabled={busy} onClick={() => setRuns(null)}>{t('common.cancel')}</Button><Button variant="danger" loading={busy} onClick={() => void terminate()} data-testid="session-end-confirm">{t('sessionNavigation.end')}</Button></>}>
      <p>{t('sessionNavigation.activeRunCount', { count: runs?.length ?? 0 })}</p>
      {error && <p role="alert">{t('safetyDialog.terminalStateChangedDescription')}</p>}
    </Dialog>
  </>;
}
