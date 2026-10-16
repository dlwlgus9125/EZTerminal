// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanningAiRequest } from '../../shared/planning-ai';
import { PlanningAiPanel, planningProposalChanges, type PlanningAiAccess } from './PlanningAiPanel';
import { planningAiFixture } from './planning-ai-fixtures';
import { sceneSnapshot } from './scene-fixtures';
import { DAEMON_PROTOCOL_VERSION } from '../../shared/daemon-protocol';

vi.mock('../i18n', () => ({ useAppTranslation: () => ({ i18n: { language: 'en' } }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const button = (name: string): HTMLButtonElement => [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === name)!;
async function fixture(options: { storageFails?: boolean; deliveryFails?: boolean; stale?: boolean } = {}) {
  const job = planningAiFixture(); const persisted: Array<PlanningAiRequest | null> = [];
  const access: PlanningAiAccess = { getDaemonSnapshot: async () => null, listDaemonProviderModels: async () => ({ ok: true, value: [] }),
    planningAiRequest: vi.fn<PlanningAiAccess['planningAiRequest']>(async request => {
      if (request.type === 'read') return { ok: true, jobs: [job] };
      expect(persisted.at(-1)).toEqual(request);
      if (options.deliveryFails) throw new Error('Connection lost');
      return { ok: true, jobs: [{ ...job, state: 'applied' }] };
    }) };
  function Harness(): JSX.Element {
    const [pending, setPending] = useState<PlanningAiRequest | null>(null);
    return <PlanningAiPanel snapshot={{ ...sceneSnapshot, revision: options.stale ? 3 : sceneSnapshot.revision }} access={access} pendingRequest={pending}
      persistPendingRequest={async request => { if (options.storageFails) throw new Error('Secure store unavailable'); persisted.push(request); setPending(request); }} onApplied={vi.fn()} />;
  }
  await act(async () => root.render(<Harness />));
  return { access, persisted };
}
describe('planning proposal review UI', () => {
  it('includes the explicitly selected stage role version and reference documents in the durable request', async () => {
    const snapshot = structuredClone(sceneSnapshot);
    snapshot.draft.profiles = [{ id: 'role-plan', revision: 2, role: 'planning', title: 'Requirements planner', instructions: 'Keep the request measurable.', contextRefs: [], allowedTools: ['planning.read'], retryLimit: 2 }];
    const provider = { id: 'claude', displayName: 'Claude', protocol: 'claude-agent-sdk', executablePath: 'claude', executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: [], enabled: true, health: 'ready' } as const;
    const requests: PlanningAiRequest[] = [];
    const access: PlanningAiAccess = { getDaemonSnapshot: async () => ({ protocolVersion: DAEMON_PROTOCOL_VERSION, revision: 1, eventSequence: 1, generatedAt: new Date().toISOString(),
      runtime: { keepRunning: false, startAtLogin: false, orchestrationToolsEnabled: false, browserEnabled: false },
      projects: [], workspaces: [], sessions: [], agents: [], agentRelations: [], turns: [], transcriptHeads: [], approvals: [], schedules: [], heartbeats: [],
      providers: [{ ...provider, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), argv: [], environmentVariableNames: [], capabilities: [] }] }),
      listDaemonProviderModels: async () => ({ ok: true, value: [{ id: 'exact-model', displayName: 'Exact model', supportsReasoning: false, isDefault: true }] }),
      planningAiRequest: async request => { if (request.type !== 'read') requests.push(request); return { ok: true, jobs: [] }; } };
    const persisted = vi.fn(async () => undefined);
    await act(async () => root.render(<PlanningAiPanel snapshot={snapshot} target={planningAiFixture().request.target} access={access} pendingRequest={null} persistPendingRequest={persisted} onApplied={vi.fn()} />));
    const selects = container.querySelectorAll('select');
    await act(async () => { selects[0].value = 'role-plan'; selects[0].dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.textContent).toContain('Keep the request measurable.');
    await act(async () => { selects[1].value = 'claude'; selects[1].dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { selects[2].value = 'exact-model'; selects[2].dispatchEvent(new Event('change', { bubbles: true })); });
    act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    const input = container.querySelector('textarea')!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Clarify the requirement'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => button('Generate proposal').click());
    expect(requests[0]).toMatchObject({ type: 'start', request: { profileId: 'role-plan', profileVersion: 2, contextIds: ['scene-chat'], model: 'exact-model' } });
    expect(persisted).toHaveBeenNthCalledWith(1, requests[0]);
  });
  it('shows field differences without applying on navigation, then persists before explicit apply', async () => {
    const { access, persisted } = await fixture();
    expect(container.textContent).toContain('Current'); expect(container.textContent).toContain('Proposed');
    expect(vi.mocked(access.planningAiRequest).mock.calls.every(([request]) => request.type === 'read')).toBe(true);
    await act(async () => button('Apply reviewed changes').click());
    expect(persisted[0]).toEqual({ type: 'apply', projectId: sceneSnapshot.projectId, requestId: 'proposal-story' });
    expect(persisted.at(-1)).toBeNull();
  });
  it('keeps an exact failed-delivery request and a newly edited instruction until explicit reconciliation', async () => {
    const { access, persisted } = await fixture({ deliveryFails: true });
    await act(async () => button('Apply reviewed changes').click());
    expect(container.textContent).toContain('Connection lost');
    expect(button('Apply reviewed changes').disabled).toBe(true);
    const input = container.querySelector('textarea')!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'New unsent instruction'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => button('Check same request').click());
    const mutations = vi.mocked(access.planningAiRequest).mock.calls.map(([request]) => request).filter(request => request.type !== 'read');
    expect(mutations).toEqual([persisted[0], persisted[0]]); expect(input.value).toBe('New unsent instruction');
  });
  it('blocks a mutation when encrypted persistence fails or the source revision changed', async () => {
    const { access } = await fixture({ storageFails: true });
    await act(async () => button('Apply reviewed changes').click());
    expect(container.textContent).toContain('Secure store unavailable');
    expect(vi.mocked(access.planningAiRequest).mock.calls.every(([request]) => request.type === 'read')).toBe(true);
  });
  it('disables stale proposal acceptance and produces readable leaf changes for added elements', async () => {
    await fixture({ stale: true }); expect(button('Apply reviewed changes').disabled).toBe(true);
    expect(planningProposalChanges({ elements: [] }, { elements: [{ id: 'new', properties: { text: 'Hello' } }] })).toEqual([
      { path: 'elements / new / id', before: '—', after: 'new' }, { path: 'elements / new / properties / text', before: '—', after: 'Hello' },
    ]);
  });
});
