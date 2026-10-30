// @vitest-environment jsdom

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatAgentProfile } from '../shared/chat-agent-profiles';
import { delegateAgentLine, DelegateAgentDialog } from './DelegateAgentDialog';
import { AppI18nProvider } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROFILES: readonly ChatAgentProfile[] = [
  { id: 'claude-build', name: 'Claude build', providerId: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high', permissionPreset: 'standard' },
  { id: 'codex-build', name: 'Codex build', providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'medium', permissionPreset: 'standard' },
];
const CODEX_MEDIUM = { providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'medium', permissionPreset: 'standard' } as const;
const CODEX_HIGH = { ...CODEX_MEDIUM, reasoningEffort: 'high' } as const;
const CODEX_HIGH_WORDS = 'Codex · GPT-6-Astra · High · Ask before running';
const NEW_WORKTREE = { kind: 'new-worktree', branch: 'suggest/taken' } as const;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const onSubmit = vi.fn(async () => ({ ok: true as const }));

function render(overrides: Partial<ComponentProps<typeof DelegateAgentDialog>> = {}): void {
  onSubmit.mockClear();
  act(() => root.render(
    <AppI18nProvider locale="en" languages={['en']}>
      <DelegateAgentDialog open onOpenChange={() => undefined} mode="handoff" profiles={PROFILES} providerLabels={{ claude: 'Claude', codex: 'Codex' }}
        workspaces={[{ id: 'ws-main', label: 'cart-kit', kind: 'local' }]} defaultWorkspaceId="ws-main" initialInstruction="Fix it" onSubmit={onSubmit} {...overrides} />
    </AppI18nProvider>,
  ));
}

const LABELS = { claude: 'Claude', codex: 'Codex' };

describe('a saved profile in words', () => {
  const opus = (_provider: string, model: string): string => (model === 'claude-opus-5-5' ? 'Opus 5.5' : model);

  it('reads like the card’s line, not as raw ids', () => {
    render({ modelLabel: opus });
    expect(document.body.textContent).toContain('Claude · Opus 5.5 · High · Ask before running');
    expect(document.body.textContent).not.toContain('claude-opus-5-5');
    expect(document.body.textContent).not.toContain('· high ·');
  });

  it('says the same in Korean, and from the shared line', () => {
    expect(delegateAgentLine(PROFILES[0]!, 'ko', LABELS, opus)).toBe('Claude · Opus 5.5 · 높음 · 승인 후 실행');
    expect(delegateAgentLine({ providerId: 'codex', permissionPreset: 'plan' }, 'en', LABELS)).toBe('Codex · Default model · Plan only · read-only');
  });
});

const byTestId = <T extends HTMLElement>(id: string): T => document.body.querySelector<T>(`[data-testid="${id}"]`)!;
const profile = (): HTMLSelectElement => byTestId('delegate-agent-profile');
const heading = (): string | null | undefined => document.body.querySelector('h2')?.textContent;

function typeBranch(text: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(byTestId('delegate-agent-branch'), text);
    byTestId('delegate-agent-branch').dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(): Promise<void> {
  await act(async () => { byTestId('delegate-agent-submit').click(); await Promise.resolve(); });
}

describe('DelegateAgentDialog', () => {
  it('keeps its title, button and first profile when nothing else is asked for', () => {
    render();
    expect(heading()).toBe('Hand off to another agent');
    expect(byTestId('delegate-agent-submit').textContent).toBe('Hand off');
    expect(profile().value).toBe('claude-build');
    expect(profile().options).toHaveLength(2);
  });

  it('takes a title and a button label for its path', () => {
    render({ title: 'Start suggested task', submitLabel: 'Start' });
    expect(heading()).toBe('Start suggested task');
    expect(byTestId('delegate-agent-submit').textContent).toBe('Start');
  });

  it('chooses the saved profile that says exactly what was asked for, not the first', async () => {
    render({ initialAgent: { ...CODEX_MEDIUM, label: 'Codex · GPT-6-Astra · Medium · Ask before running' } });
    expect(profile().value).toBe('codex-build');
    expect(profile().options).toHaveLength(2);
    await submit();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'codex-build' }));
  });

  it('shows the settings as they are when no saved profile matches, and keeps them when only the branch changes', async () => {
    render({ initialAgent: { ...CODEX_HIGH, label: CODEX_HIGH_WORDS }, initialWorkspace: NEW_WORKTREE });
    expect(profile().selectedOptions[0]?.textContent).toBe(CODEX_HIGH_WORDS);
    expect(document.body.textContent).toContain('Not a saved profile');
    expect((byTestId<HTMLInputElement>('delegate-agent-branch')).value).toBe('suggest/taken');
    typeBranch('suggest/free');
    expect(profile().selectedOptions[0]?.textContent).toBe(CODEX_HIGH_WORDS);
    await submit();
    expect(onSubmit).toHaveBeenCalledWith({
      agent: CODEX_HIGH, workspace: { kind: 'new-worktree', branch: 'suggest/free' }, instruction: 'Fix it', reportBack: false,
    });
  });

  it('never matches on part of the settings: another permission is another start', () => {
    render({ initialAgent: { ...CODEX_MEDIUM, permissionPreset: 'full-access', label: 'Codex · full access' } });
    expect(profile().selectedOptions[0]?.textContent).toBe('Codex · full access');
  });

  it('can still start with no saved profiles at all', async () => {
    render({ profiles: [], initialAgent: { ...CODEX_HIGH, label: CODEX_HIGH_WORDS } });
    expect(profile().selectedOptions[0]?.textContent).toBe(CODEX_HIGH_WORDS);
    await submit();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ agent: CODEX_HIGH }));
  });
});
