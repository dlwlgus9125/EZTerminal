// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonApproval } from '../../shared/daemon-protocol';
import type { SettingsChangedEvent, SettingsChangesAccess, SettingsConversationView } from '../../shared/settings-changes';
import { useConversationSettings } from '../conversation-settings-track';
import { AppI18nProvider } from '../i18n';
import { clearSessionViewStates } from '../session-view-state';
import { StructuredAgentSessionPanel } from '../StructuredAgentSession';
import { SettingsProposalContext, type SettingsProposalEntry } from './SettingsChangeTrack';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-10-29T09:31:00.000Z';
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  clearSessionViewStates();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: ReactNode): void {
  act(() => root.render(<AppI18nProvider locale="ko" languages={['ko']}>{node}</AppI18nProvider>));
}
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const approval = (state: DaemonApproval['state'] = 'pending'): DaemonApproval => ({
  id: 'approval-1', sessionId: 'chat-1', providerRequestId: 'settings-proposal:p-1', risk: 'danger', title: '설정 제안: 원격 접속 켜기',
  detail: '원격 접속: 끔 → 켬', request: { v: 1, kind: 'tool', toolName: 'EZTerminal 설정', target: '원격 접속 켜기', input: '원격 접속: 끔 → 켬\n\n켜면 페어링한 폰이 이 PC를 조작할 수 있습니다.' },
  state, revision: 1, createdAt: NOW, updatedAt: NOW,
});
const proposal: SettingsProposalEntry = { id: 'p-1', title: '원격 접속 켜기', desktopOnly: true, rows: [{ name: '원격 접속', before: '끔', after: '켬' }], risk: '켜면 페어링한 폰이 이 PC를 조작할 수 있습니다.' };

function panel(onResolveApproval = vi.fn(async () => ({ ok: true as const }))): JSX.Element {
  return <StructuredAgentSessionPanel sessionId="chat-1" title="Chat" providerId="codex" providerLabel="Codex" workspace={{ id: 'workspace-1', label: 'App', kind: 'local' }}
    model="gpt" modelOptions={[{ id: 'gpt', label: 'GPT' }]} permissionPreset="standard" state="idle" items={[]} approvals={[approval()]} approvalResponses approvalSession
    onSend={async () => ({ ok: true })} onChangeSettings={async () => ({ ok: true })} onResolveApproval={onResolveApproval} />;
}

describe('a settings proposal in the approval dock', () => {
  it('shows the rows and applies once, never for the whole conversation', async () => {
    const resolve = vi.fn(async () => ({ ok: true as const }));
    render(<SettingsProposalContext.Provider value={{ ko: true, proposal: (id) => (id === 'approval-1' ? proposal : undefined) }}>{panel(resolve)}</SettingsProposalContext.Provider>);
    const dock = container.querySelector('[data-testid="chat-dock-settings-proposal"]')!;
    expect(dock.textContent).toContain('원격 접속');
    expect(dock.querySelector('table')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-dock-allow-session"]')).toBeNull();
    expect(container.textContent).toContain('원격 접속 켜기');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="chat-dock-apply-settings"]')!.click());
    await flush();
    expect(resolve).toHaveBeenCalledWith('approval-1', 'allow');
  });

  it('says a PC-only proposal is applied on the PC when shown on a phone, and still lets it be declined', async () => {
    const resolve = vi.fn(async () => ({ ok: true as const }));
    render(<SettingsProposalContext.Provider value={{ ko: true, onPhone: true, proposal: () => proposal }}>{panel(resolve)}</SettingsProposalContext.Provider>);
    expect(container.querySelector('[data-testid="chat-dock-apply-settings"]')).toBeNull();
    expect(container.textContent).toContain('이 설정은 PC에서만 적용할 수 있습니다.');
    const decline = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '거절')!;
    act(() => decline.click());
    await flush();
    expect(resolve).toHaveBeenCalledWith('approval-1', 'deny');
  });

  it('gives the dock to an approval the agent is blocked on before an older settings proposal', () => {
    const command: DaemonApproval = { id: 'approval-2', sessionId: 'chat-1', turnId: 'turn-1', providerRequestId: 'provider-1', risk: 'write', title: 'Run pnpm test',
      request: { v: 1, kind: 'command', command: 'pnpm test' }, state: 'pending', revision: 1, createdAt: '2026-10-29T09:32:00.000Z', updatedAt: '2026-10-29T09:32:00.000Z' };
    render(<StructuredAgentSessionPanel sessionId="chat-1" title="Chat" providerId="codex" providerLabel="Codex" workspace={{ id: 'workspace-1', label: 'App', kind: 'local' }}
      model="gpt" modelOptions={[{ id: 'gpt', label: 'GPT' }]} permissionPreset="standard" state="blocked" items={[]} approvals={[approval(), command]}
      onSend={async () => ({ ok: true })} onChangeSettings={async () => ({ ok: true })} onResolveApproval={vi.fn(async () => ({ ok: true as const }))} />);
    expect(container.querySelector('[data-testid="chat-dock-settings-proposal"]')).toBeNull();
    expect(container.textContent).toContain('$ pnpm test');
  });

  it('falls back to its readable text where the host gives no rows (an older or other client)', () => {
    render(panel());
    expect(container.querySelector('[data-testid="chat-dock-settings-proposal"]')!.textContent).toContain('원격 접속: 끔 → 켬');
  });
});

describe('what the AI changed in this conversation', () => {
  function Track({ access, approvals }: { readonly access: SettingsChangesAccess; readonly approvals: readonly DaemonApproval[] }): JSX.Element {
    const { track } = useConversationSettings({ sessionId: 'chat-1', approvals, korean: true, access });
    return <>{track}</>;
  }
  const view: SettingsConversationView = {
    changes: [
      { id: 'c-1', at: NOW, actor: { kind: 'ai', sessionId: 'chat-1' }, domain: 'ui', target: 'effects.scanlines', before: true, after: false, undone: false, conflict: false },
      { id: 'c-2', at: NOW, actor: { kind: 'ai', sessionId: 'chat-1' }, domain: 'ui', target: 'theme', before: 'matrix', after: 'light', undone: false, conflict: true, current: 'dark' },
    ],
    proposals: [
      { id: 'p-1', approvalId: 'approval-1', sessionId: 'chat-1', at: NOW, title: '원격 접속 켜기', rows: proposal.rows, risk: proposal.risk, desktopOnly: true, state: 'pending' },
      { id: 'p-2', approvalId: 'approval-2', sessionId: 'chat-1', at: NOW, title: '반복 켜기', rows: [], risk: '', desktopOnly: true, state: 'failed', detail: '검토 AI를 먼저 고르세요' },
    ],
  };
  function access(): SettingsChangesAccess & { emit(event: SettingsChangedEvent): void } {
    const listeners = new Set<(event: SettingsChangedEvent) => void>();
    return {
      conversation: vi.fn(async () => view),
      undo: vi.fn(async () => ({ ok: true as const, changeId: 'c-3' })),
      advisor: async () => false,
      setAdvisor: async () => false,
      onChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      emit: (event) => { for (const listener of listeners) listener(event); },
    };
  }

  it('lists the changes with 되돌리기, shows the difference for one changed since, and the proposal outcomes', async () => {
    const fake = access();
    render(<Track access={fake} approvals={[approval('expired')]} />);
    await flush();
    const track = container.querySelector('[data-testid="settings-change-track"]')!;
    expect(track.textContent).toContain('화면 효과: 주사선: 켬 → 끔');
    expect(track.textContent).toContain('그 뒤 바뀌어 되돌릴 수 없음');
    // The dock decides a pending proposal; an expired or failed one shows here.
    expect([...track.querySelectorAll('[data-testid="settings-proposal"]')].map((node) => node.getAttribute('data-state'))).toEqual(['expired', 'failed']);
    const undo = [...track.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('되돌리기'))!;
    act(() => undo.click());
    await flush();
    expect(fake.undo).toHaveBeenCalledWith('c-1');
    const diff = [...track.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('차이 보기'))!;
    act(() => diff.click());
    expect(container.querySelector('[data-testid="settings-change-diff"]')!.textContent).toContain('다크');
    act(() => fake.emit({ domains: ['ui'] }));
    await flush();
    expect(fake.conversation).toHaveBeenCalledTimes(3);
  });
});
