// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkflowConversationScope, WorkflowConversationContext } from './WorkflowConversationContext';
import type { WorkflowAccess } from '../../shared/workflow';
import { workflowFixture } from './workflow-fixtures';
vi.mock('../i18n', () => ({ useAppTranslation: () => ({ i18n: { language: 'en' } }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let element: HTMLDivElement;
beforeEach(() => { element = document.createElement('div'); document.body.append(element); root = createRoot(element); });
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
function Probe({ access }: { access: WorkflowAccess }): JSX.Element {
  const state = useWorkflowConversationScope(access, 'project-story', 'chat-stage');
  return <><output data-loading={state.loading} data-readonly={state.scope?.readOnly}>{state.error}</output>{state.scope && <WorkflowConversationContext scope={state.scope} onRefresh={state.refreshReferences} />}</>;
}
describe('stage conversation context', () => {
  it('uses authoritative content staleness rather than the registry revision and refreshes explicitly', async () => {
    const snapshot = workflowFixture(); const link = snapshot.sessionLinks[0];
    link.referenceSnapshot = { projectId: snapshot.projectId, subprojectId: 'login', nodeId: 'login:research', graphRevision: 0, fingerprint: 'a'.repeat(64), title: 'Saved stage', document: 'Frozen document', instructions: '', references: [] };
    link.referenceStale = false;
    const execute = vi.fn(async () => ({ ok: true as const, snapshot }));
    const access: WorkflowAccess = { getWorkflowSnapshot: async () => ({ ok: true, snapshot }), executeWorkflowCommand: execute };
    await act(async () => root.render(<Probe access={access} />));
    expect(element.textContent).toContain('Frozen document'); expect(element.textContent).not.toContain('The saved document changed');
    await act(async () => element.querySelector<HTMLButtonElement>('button')!.click());
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.refresh', payload: { sessionId: 'chat-stage' } }));
  });
  it('keeps an archived stage read-only while preserving its saved references', async () => {
    const snapshot = workflowFixture(); snapshot.subprojects[0].status = 'archived';
    const access: WorkflowAccess = { getWorkflowSnapshot: async () => ({ ok: true, snapshot }), executeWorkflowCommand: vi.fn() };
    await act(async () => root.render(<Probe access={access} />));
    expect(element.querySelector('output')?.dataset.readonly).toBe('true');
    expect(element.textContent).toContain('Archived record'); expect(element.textContent).not.toContain('Refresh references');
  });
  it('allows ordinary chat on older hosts but fails closed with a visible reason on an uncertain current host', async () => {
    const access: WorkflowAccess = { getWorkflowSnapshot: async () => ({ ok: false, error: 'unsupported', message: 'Update host for workflows' }), executeWorkflowCommand: vi.fn() };
    await act(async () => root.render(<Probe access={access} />));
    expect(element.querySelector('output')?.dataset.loading).toBe('false'); expect(element.textContent).toContain('Update host');
    await act(async () => root.render(<Probe access={{ ...access, getWorkflowSnapshot: async () => ({ ok: false, error: 'unavailable', message: 'Host disconnected' }) }} />));
    expect(element.querySelector('output')?.dataset.loading).toBe('true'); expect(element.textContent).toContain('Host disconnected');
  });
});
