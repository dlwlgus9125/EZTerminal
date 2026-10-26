import { useEffect, useRef, useState } from 'react';
import type { EzTerminalApi } from '../shared/ipc';
import { sameActiveRunSet } from '../shared/close-risk';
import { useAppTranslation } from './i18n';
import { Button, Dialog } from './ui';

type SessionEndAccess = Pick<EzTerminalApi, 'listRuns' | 'terminateSessionGuarded'>;

/**
 * The guarded end of a terminal session: read its active runs, ask with that count, and end it
 * only if the runs are still the ones the person saw. Ending is independent of which device owns
 * an open view.
 */
function useGuardedSessionEnd(sessionId: string, access: SessionEndAccess) {
  const [runs, setRuns] = useState<readonly string[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const latestRuns = async () => (await access.listRuns()).filter((run) => run.sessionId === sessionId).map((run) => run.runId);
  const prepare = async (): Promise<void> => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(false);
    try { setRuns(await latestRuns()); } catch { setError(true); }
    finally { lock.current = false; setBusy(false); }
  };
  /** True once the session ended. */
  const terminate = async (): Promise<boolean> => {
    if (lock.current || runs === null) return false;
    lock.current = true; setBusy(true); setError(false);
    try {
      const current = await latestRuns();
      if (!sameActiveRunSet(current, runs)) { setRuns(current); setError(true); return false; }
      const result = await access.terminateSessionGuarded(sessionId, current);
      if (result.ok) { setRuns(null); return true; }
      setError(true); setRuns(await latestRuns());
      return false;
    } catch { setError(true); return false; }
    finally { lock.current = false; setBusy(false); }
  };
  return { runs, error, busy, prepare, terminate, cancel: () => setRuns(null) };
}

function SessionEndDialog({ open, title, end, onCancel, onEnded }: {
  readonly open: boolean;
  readonly title: string;
  readonly end: ReturnType<typeof useGuardedSessionEnd>;
  readonly onCancel: () => void;
  readonly onEnded?: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !end.busy) onCancel(); }} role="alertdialog" tone="danger"
      title={`${t('sessionNavigation.end')}: ${title}`} description={t('sessionNavigation.endDescription')}
      initialFocusRef={cancelRef} closeLabel={t('common.cancel')} testId="session-end-dialog"
      footer={<>
        <Button ref={cancelRef} disabled={end.busy} onClick={onCancel}>{t('common.cancel')}</Button>
        {end.runs !== null && <Button variant="danger" loading={end.busy} onClick={() => void end.terminate().then((ended) => { if (ended) onEnded?.(); })} data-testid="session-end-confirm">{t('sessionNavigation.end')}</Button>}
      </>}>
      {end.runs !== null && <p>{t('sessionNavigation.activeRunCount', { count: end.runs.length })}</p>}
      {end.error && <p role="alert">{end.runs === null ? t('safetyDialog.terminalStateUnavailableDescription') : t('safetyDialog.terminalStateChangedDescription')}</p>}
    </Dialog>
  );
}

/** A row's 세션 종료 button and its confirmation. */
export function TerminalSessionActions({ sessionId, title, access }: {
  readonly sessionId: string;
  readonly title: string;
  readonly access: SessionEndAccess;
}): JSX.Element {
  const { t } = useAppTranslation();
  const end = useGuardedSessionEnd(sessionId, access);
  return <>
    <Button variant="ghost" size="sm" disabled={end.busy} onClick={() => void end.prepare()} aria-label={`${t('sessionNavigation.end')}: ${title}`} data-testid="session-end">{t('sessionNavigation.end')}</Button>
    {end.error && end.runs === null && <p role="alert">{t('safetyDialog.terminalStateUnavailableDescription')}</p>}
    <SessionEndDialog open={end.runs !== null} title={title} end={end} onCancel={end.cancel} />
  </>;
}

/**
 * The same guarded end opened from elsewhere (a terminal tab's 세션 종료): it reads the runs as it
 * opens; when they cannot be read it says so and offers no end.
 */
export function TerminalSessionEndDialog({ sessionId, title, access, onClose }: {
  readonly sessionId: string;
  readonly title: string;
  readonly access: SessionEndAccess;
  readonly onClose: (ended: boolean) => void;
}): JSX.Element {
  const end = useGuardedSessionEnd(sessionId, access);
  const { prepare } = end;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void prepare(); }, [sessionId]);
  return <SessionEndDialog open title={title} end={end} onCancel={() => onClose(false)} onEnded={() => onClose(true)} />;
}
