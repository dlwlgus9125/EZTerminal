import { useEffect, useState } from 'react';

import type { ExecutionRun } from '../../shared/planning-execution';
import type { PlanningIntegrationRecord } from '../../shared/planning-result';
import type { PlanningResultReader } from '../PlanningResultDetails';

/** Where a run's integration stands, as the run bar shows it (null: not integrated yet or unknown). */
export interface RunIntegrationView {
  readonly status: PlanningIntegrationRecord['status'] | null;
  readonly loading: boolean;
}

/** How often a record that is missing or not final is read again. */
export const INTEGRATION_POLL_MS = 5_000;

/**
 * The integration record of the run the flow shows. It exists only after the person (or 자동 승인)
 * allowed integration, so nothing is read before that; then once per run revision, and again every few
 * seconds while it is missing or not final: validation and adoption save their status without moving the
 * run's revision.
 */
export function useRunIntegration(read: PlanningResultReader | undefined, projectId: string | undefined, subprojectId: string, run: ExecutionRun | null): RunIntegrationView | null {
  const runId = run?.runId;
  const revision = run?.revision;
  const allowed = Boolean(run?.integrationAuthorized);
  const [view, setView] = useState<RunIntegrationView | null>(null);
  useEffect(() => {
    if (!read || !projectId || !runId || !allowed) { setView(null); return undefined; }
    let current = true;
    setView((previous) => ({ status: previous?.status ?? null, loading: true }));
    void read({ kind: 'integration', projectId, subprojectId, runId })
      .then((result) => { if (current) setView({ status: result.ok && result.kind === 'integration' ? result.integration?.status ?? null : null, loading: false }); })
      .catch(() => { if (current) setView({ status: null, loading: false }); });
    return () => { current = false; };
  }, [read, projectId, subprojectId, runId, revision, allowed]);
  useEffect(() => {
    if (!read || !projectId || !runId || !allowed || !view || view.loading || view.status === 'passed' || view.status === 'failed') return undefined;
    let current = true;
    const timer = window.setTimeout(() => {
      void read({ kind: 'integration', projectId, subprojectId, runId })
        .then((result) => { if (current) setView({ status: result.ok && result.kind === 'integration' ? result.integration?.status ?? null : null, loading: false }); })
        .catch(() => { if (current) setView((previous) => (previous ? { ...previous } : previous)); });
    }, INTEGRATION_POLL_MS);
    return () => { current = false; window.clearTimeout(timer); };
  }, [read, projectId, subprojectId, runId, allowed, view]);
  return view;
}
