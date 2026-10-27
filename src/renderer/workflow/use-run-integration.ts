import { useEffect, useState } from 'react';

import type { ExecutionRun } from '../../shared/planning-execution';
import type { PlanningIntegrationRecord } from '../../shared/planning-result';
import type { PlanningResultReader } from '../PlanningResultDetails';

/** Where a run's integration stands, as the run bar shows it (null: not integrated yet or unknown). */
export interface RunIntegrationView {
  readonly status: PlanningIntegrationRecord['status'] | null;
  readonly loading: boolean;
}

/**
 * The integration record of the run the flow shows. It exists only after the person (or 자동 승인)
 * allowed integration, so nothing is read before that; then once per run revision.
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
  return view;
}
