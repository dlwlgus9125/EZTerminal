// @vitest-environment jsdom
// Phase B (harness mockup) parity: the new pieces may add controls but must not silently drop a shipped one.
// Each surface renders as the app ships it and with the mockup's additions; every interactive element of the
// first must still be in the second. A deliberate replacement is listed with its reason (also in approvals.md).
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppI18nProvider } from '../i18n';
import { resetPlanAccessForTests } from '../agent-plan-access';
import { clearSessionViewStates } from '../session-view-state';
import { SettingsChangeTrack } from '../chat/SettingsChangeTrack';
import { StructuredAgentSessionPanel, type StructuredAgentSessionPanelProps } from '../StructuredAgentSession';
import { WorkflowFlowSurface, type WorkflowFlowSurfaceProps } from '../workflow/WorkflowFlowSurface';
import { WorkflowAgentList } from '../workflow/WorkflowAgentList';
import { WorkflowStageAgent } from '../workflow/WorkflowStageAgent';
import { HARNESS_GRAPH, STORY_EFFORTS, STORY_PERMISSIONS, STORY_REVIEWS, harnessAgents, harnessDecorations } from './harness-fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { clearSessionViewStates(); localStorage.clear(); resetPlanAccessForTests(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

function render(node: ReactNode): void {
  act(() => root.render(<AppI18nProvider locale="ko" languages={['ko']}>{node}</AppI18nProvider>));
}
/** Every interactive element a person can reach: test ids, and controls by role + accessible name. */
function inventory(scope: ParentNode): Set<string> {
  const found = new Set<string>();
  scope.querySelectorAll<HTMLElement>('[data-testid]').forEach((element) => found.add(`testid:${element.dataset.testid}`));
  scope.querySelectorAll<HTMLElement>('button, select, textarea, input, [role="button"], [role="radio"], [role="tab"]').forEach((element) => {
    // A field by its label's own words (not the typed value); a button by its label or first heading (extra detail lines may be added).
    const label = (element as HTMLInputElement).labels?.[0] ?? element.closest('label');
    const own = label ? [...label.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE || (node as Element).tagName === 'SPAN').map((node) => node.textContent ?? '').join('') : '';
    const name = element.getAttribute('aria-label') ?? (own.trim() || element.querySelector('strong')?.textContent || element.textContent || '').trim().replace(/\s+/gu, ' ').slice(0, 60);
    found.add(`${element.tagName.toLowerCase()}:${name}`);
  });
  return found;
}
const missing = (before: Set<string>, after: Set<string>, allowed: readonly string[] = []) => [...before].filter((key) => !after.has(key) && !allowed.includes(key));

const chat: StructuredAgentSessionPanelProps = {
  sessionId: 'parity-chat', title: 'Parity', providerId: 'claude', providerLabel: 'Claude', workspace: { id: 'ws', label: 'App', kind: 'local' },
  model: 'claude-opus-5-5', modelOptions: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }], permissionPreset: 'standard', state: 'working', items: [],
  effortSupported: true, reasoningEffort: 'high', usage: { weekly: { usedPercent: 21 }, limitsObservedAt: 1, contextPercent: 30, contextObservedAt: 1 },
  onSend: async () => ({ ok: true }), onChangeSettings: async () => ({ ok: true }),
};

describe('harness mockup keeps every shipped control', () => {
  it('the input box: + menu, 계획, model, effort, permission, folder, usage and send/stop stay with the queued line', () => {
    render(<StructuredAgentSessionPanel {...chat} />);
    const before = inventory(container);
    render(<StructuredAgentSessionPanel {...chat} queueSettings pendingSettings={{ current: '높음', next: '보통', onCancel: () => undefined }}
      effortScope={{ value: 'once', onChange: () => undefined }}
      settingsTrack={<SettingsChangeTrack ko changes={[{ id: 'c', label: '테마: Matrix → Light', at: '09:31' }]} proposals={[]} />} />);
    const after = inventory(container);
    expect(missing(before, after)).toEqual([]);
    expect(after.has('testid:structured-agent-pending-settings')).toBe(true);
    expect(after.has('testid:settings-change-track')).toBe(true);
  });

  it('the flow side panel: the agent list is added above; the stage keeps everything but AI · 모델 · 노력 · 고급, which the agent settings replace', () => {
    const base: WorkflowFlowSurfaceProps = {
      text: (ko) => ko, savedGraph: HARNESS_GRAPH, draftGraph: null, revision: 6, archivedNodes: [], runs: [], editLocked: false, commandsDisabled: false, issues: [],
      providers: [{ id: 'claude', label: 'Claude', models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }] }] as never,
      selection: { kind: 'node', id: 'dev:mock' }, onSelectionChange: vi.fn(), section: 'settings', onSectionChange: vi.fn(), pickedRunId: null, onPickRun: vi.fn(),
      runView: false, onRunViewChange: vi.fn(), layout: 'list', onLayoutChange: vi.fn(), onGraphChange: vi.fn(), onSaveDraft: vi.fn(), onDiscardDraft: vi.fn(), onLaunch: vi.fn(),
      onSaveReviewer: vi.fn(), onAutoApprove: vi.fn(), onRunCommand: vi.fn(), stageLinks: () => [], canStartStageChat: true, onStartStageChat: vi.fn(),
      subproject: { id: 'dev', status: 'active', runSettings: { reviewer: { providerId: 'codex', model: 'gpt-6-astra' } } }, structure: false, onStructureChange: vi.fn(),
    };
    render(<WorkflowFlowSurface {...base} />);
    const before = inventory(container);
    const decorations = harnessDecorations();
    render(<WorkflowFlowSurface {...base} decorations={decorations.nodes} edgeDecorations={decorations.edges}
      panelTop={<WorkflowAgentList text={(ko) => ko} agents={harnessAgents()} open onOpenChange={vi.fn()} targetStage="시안" onAssign={vi.fn()} />}
      stageSlots={() => ({ settings: <WorkflowStageAgent text={(ko) => ko} agent={{ name: '설계 담당', detail: 'Claude · Opus 5.5', tone: 'claude', permissionLabel: '승인 후 실행' }}
        session={{ value: 'continue', from: '계획' }} effort={{ value: 'medium', options: STORY_EFFORTS }} permission={{ value: 'standard', options: STORY_PERMISSIONS }}
        checks={[]} review={{ value: 'run', options: STORY_REVIEWS }} /> })} />);
    const after = inventory(container);
    // Replaced by the agent placed on the stage (WorkflowStageAgent): who and how hard now come from the agent + the stage's overrides.
    const replaced = [...before].filter((key) => /^select:(AI|모델|노력)|^testid:workflow-stage-(effort|advanced)$/u.test(key));
    expect(missing(before, after, replaced)).toEqual([]);
    expect(after.has('testid:workflow-agent-list')).toBe(true);
    expect(after.has('testid:workflow-stage-agent')).toBe(true);
  });
});
