// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanningRunRequestSchema, type PlanningRunRequest } from '../shared/planning-run';
import { PlanningExecutionSnapshotSchema } from '../shared/planning-execution';
import { PlanningExecutionPanel, type PlanningExecutionAccess } from './PlanningExecutionPanel';
import { planningExecutionFixture } from './planning-execution-fixtures';

vi.mock('./i18n', () => ({ useAppTranslation: () => ({ i18n: { language: 'en' } }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const button = (name: string): HTMLButtonElement => {
  const node = [...container.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === name);
  if (!node) throw new Error(`Missing button ${name}`);
  return node;
};
const click = async (name: string): Promise<void> => { await act(async () => button(name).click()); };
function Harness({ access, persist }: { access: PlanningExecutionAccess; persist: (request: PlanningRunRequest | null) => Promise<void> }): JSX.Element {
  const [pending, setPending] = useState<PlanningRunRequest | null>(null);
  return <PlanningExecutionPanel planning={planningExecutionFixture().planning} access={access} disabled={false} pendingRequest={pending} persistPendingRequest={async (request) => { await persist(request); setPending(request); }} />;
}
function accessFor(execute: PlanningExecutionAccess['executePlanningRun']): PlanningExecutionAccess {
  return { getPlanningExecutionSnapshot: async () => ({ ok: true, snapshot: planningExecutionFixture().execution }), executePlanningRun: execute, getDaemonSnapshot: async () => null, listDaemonProviderModels: async () => ({ ok: true, value: [] }) };
}
describe('PlanningExecutionPanel commands', () => {
  it('does not start prepared work on navigation and persists identity before explicit start', async () => {
    const fixture = planningExecutionFixture();
    PlanningExecutionSnapshotSchema.parse(fixture.execution);
    const persisted: (PlanningRunRequest | null)[] = [];
    const execute = vi.fn<PlanningExecutionAccess['executePlanningRun']>(async (request) => {
      PlanningRunRequestSchema.parse(request);
      expect(persisted.at(-1)).toEqual(request);
      return { ok: true, snapshot: fixture.execution, commandId: request.commandId };
    });
    await act(async () => root.render(<Harness access={accessFor(execute)} persist={async (request) => { persisted.push(request); }} />));
    expect(execute).not.toHaveBeenCalled();
    await click('Start with these settings');
    expect(execute.mock.calls[0][0]).toMatchObject({ type: 'start', projectId: fixture.planning.projectId, expectedRevision: 1, payload: { runId: 'run-example' } });
    expect(persisted.at(-1)).toBeNull();
  });
  it('keeps uncertain requests for explicit reconciliation with the exact command ID', async () => {
    const execute = vi.fn<PlanningExecutionAccess['executePlanningRun']>().mockRejectedValue(new Error('Connection lost'));
    await act(async () => root.render(<Harness access={accessFor(execute)} persist={async () => undefined} />));
    await click('Start with these settings');
    expect(button('Start with these settings').disabled).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    await click('Check execution request');
    expect(execute.mock.calls[1][0]).toEqual(execute.mock.calls[0][0]);
  });
  it('never sends a command when durable persistence fails', async () => {
    const execute = vi.fn<PlanningExecutionAccess['executePlanningRun']>();
    await act(async () => root.render(<Harness access={accessFor(execute)} persist={async () => { throw new Error('Secure store unavailable'); }} />));
    await click('Start with these settings');
    expect(execute).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Secure store unavailable');
  });
  it('does not offer an extra repair after the frozen retry limit is exhausted', async () => {
    const fixture = planningExecutionFixture();
    const execute = vi.fn<PlanningExecutionAccess['executePlanningRun']>();
    const access = accessFor(execute);
    access.getPlanningExecutionSnapshot = async () => ({ ok: true, snapshot: { ...fixture.execution, runs: [{ ...fixture.execution.runs[0], state: 'paused', tasks: [{ taskId: 'task-terminal', state: 'failed', retriesUsed: 2 }] }] } });
    await act(async () => root.render(<Harness access={access} persist={async () => undefined} />));
    expect(button('Retry repair').disabled).toBe(true);
    expect(container.textContent).toContain('Repair retries 2/2');
    expect(execute).not.toHaveBeenCalled();
  });
});
