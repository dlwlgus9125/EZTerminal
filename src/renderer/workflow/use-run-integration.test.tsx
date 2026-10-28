// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecutionRun } from '../../shared/planning-execution';
import type { PlanningResultReader } from '../PlanningResultDetails';
import { INTEGRATION_POLL_MS, useRunIntegration, type RunIntegrationView } from './use-run-integration';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.useFakeTimers(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

const run = { runId: 'run', revision: 4, integrationAuthorized: true } as unknown as ExecutionRun;
const record = (status: 'validating' | 'passed') => ({ ok: true as const, kind: 'integration' as const, integration: { status } }) as unknown as Awaited<ReturnType<PlanningResultReader>>;

describe('useRunIntegration', () => {
  it('reads a not-final record again while the run revision stays the same, and stops once it is final', async () => {
    const answers = [record('validating'), record('validating'), record('passed')];
    const read = vi.fn<PlanningResultReader>(async () => answers.shift() ?? record('passed'));
    let seen: RunIntegrationView | null = null;
    function Probe(): null { seen = useRunIntegration(read, 'P', 'S', run); return null; }
    await act(async () => root.render(<Probe />));
    expect(seen).toEqual({ status: 'validating', loading: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(INTEGRATION_POLL_MS); });
    expect(seen).toEqual({ status: 'validating', loading: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(INTEGRATION_POLL_MS); });
    expect(seen).toEqual({ status: 'passed', loading: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(INTEGRATION_POLL_MS * 3); });
    expect(read).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenLastCalledWith({ kind: 'integration', projectId: 'P', subprojectId: 'S', runId: 'run' });
  });
});
