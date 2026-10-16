// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCapabilitiesClient, AgentCapabilityCatalog } from '../shared/agent-capabilities';
import { AgentCapabilitiesPanel } from './AgentCapabilitiesPanel';
import { StructuredAgentDraftPanel, StructuredAgentSessionPanel, type StructuredAgentDraftPanelProps } from './StructuredAgentSession';
import { AppI18nProvider } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const catalog = (workspaceId = 'ws'): AgentCapabilityCatalog => ({ providerId: 'codex', workspaceId, workspaceRoot: `/work/${workspaceId}`, hostId: 'PC-1', revision: 'a'.repeat(64), observedAt: '2026-10-13T00:00:00Z', canManage: true, application: 'new-session', models: [{ id: 'native-model', displayName: 'Discovered model', supportsReasoning: false, isDefault: true }], items: [{ id: '/skills/review', name: 'Review', kind: 'skill', enabled: true, invocation: '$review', actions: [] }], actions: ['plugin-install'], issues: [] });
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const render = (element: JSX.Element): void => { act(() => root.render(<AppI18nProvider locale="en" languages={['en']}>{element}</AppI18nProvider>)); };
const button = (label: string): HTMLButtonElement => { const found = [...container.querySelectorAll('button')].find((entry) => entry.textContent === label); if (!found) throw new Error(`Missing button ${label}`); return found; };
const click = async (label: string): Promise<void> => { act(() => button(label).click()); await flush(); };
function target(value: string): void {
  const input = container.querySelector<HTMLInputElement>('input[placeholder="plugin@marketplace"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
describe('Agent capability discovery and management', () => {
  it('discovers before a session and carries inserted text without creating or sending', async () => {
    const onCreate = vi.fn<StructuredAgentDraftPanelProps['onCreate']>(async () => ({ ok: true as const }));
    const client: AgentCapabilitiesClient = { list: vi.fn<AgentCapabilitiesClient['list']>(async () => ({ ok: true, value: catalog() })), manage: vi.fn() };
    render(<StructuredAgentDraftPanel capabilityClient={client} providers={[{ id: 'codex', label: 'Codex', models: [] }]} workspaces={[{ id: 'ws', label: 'Work', kind: 'local' }]} onCreate={onCreate} />);
    await flush();
    expect(client.list).toHaveBeenCalledExactlyOnceWith({ providerId: 'codex', workspaceId: 'ws' });
    expect(container.textContent).toContain('Discovered model');
    await click('Insert');
    expect(onCreate).not.toHaveBeenCalled();
    act(() => container.querySelector<HTMLFormElement>('.structured-agent-draft-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ draftText: '$review ' }));
    expect(onCreate.mock.calls[0][0].draftSkills).toEqual([{ providerId: 'codex', id: '/skills/review', name: 'Review', invocation: '$review' }]);
    expect(onCreate.mock.calls[0][0]).not.toHaveProperty('initialPrompt');
  });

  it('inserts in the existing composer, verifies it before first send and preserves unavailable selections', async () => {
    const onSend = vi.fn(async () => ({ ok: true as const }));
    const list = vi.fn<AgentCapabilitiesClient['list']>().mockResolvedValueOnce({ ok: true, value: catalog() }).mockResolvedValue({ ok: true, value: { ...catalog(), items: [] } });
    render(<StructuredAgentSessionPanel capabilityClient={{ list, manage: vi.fn() }} sessionId="s" title="Chat" providerId="codex" providerLabel="Codex" workspace={{ id: 'ws', label: 'Work', kind: 'local' }} permissionPreset="standard" state="idle" items={[]} awaitingFirstMessage onSend={onSend} />);
    await flush(); await click('Insert');
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-composer-input"]')!;
    expect(input.value).toBe('$review ');
    expect(onSend).not.toHaveBeenCalled();
    act(() => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('$review ');
    expect(container.textContent).toContain('no longer available');
  });

  it('checks the exact command after an uncertain reply and blocks a fresh mutation', async () => {
    const manage = vi.fn<AgentCapabilitiesClient['manage']>().mockRejectedValueOnce(new Error('Disconnected')).mockImplementation(async (request) => ({ ok: true, value: { commandId: request.commandId, action: request.action, state: 'applied', application: 'new-session' } }));
    const client: AgentCapabilitiesClient = { list: vi.fn<AgentCapabilitiesClient['list']>(async () => ({ ok: true, value: catalog() })), manage };
    render(<AgentCapabilitiesPanel client={client} providerId="codex" workspaceId="ws" />);
    await flush(); target('sample@market'); await click('Apply to PC settings');
    expect(button('Apply to PC settings').disabled).toBe(true);
    await click('Check same request');
    expect(manage).toHaveBeenCalledTimes(2);
    expect(manage.mock.calls[1][0]).toEqual(manage.mock.calls[0][0]);
    expect(button('Apply to PC settings').disabled).toBe(false);
  });

  it('does not restore a previous workspace catalog when a delayed mutation finishes', async () => {
    let finish!: (value: Awaited<ReturnType<AgentCapabilitiesClient['manage']>>) => void;
    const manage = vi.fn<AgentCapabilitiesClient['manage']>(() => new Promise((resolve) => { finish = resolve; }));
    const client: AgentCapabilitiesClient = { list: vi.fn<AgentCapabilitiesClient['list']>(async (request) => ({ ok: true, value: catalog(request.workspaceId) })), manage };
    render(<AgentCapabilitiesPanel client={client} providerId="codex" workspaceId="A" />);
    await flush(); target('sample@market'); await click('Apply to PC settings');
    render(<AgentCapabilitiesPanel client={client} providerId="codex" workspaceId="B" />);
    await flush();
    await act(async () => { finish({ ok: true, value: { commandId: manage.mock.calls[0][0].commandId, action: 'plugin-install', state: 'applied', application: 'new-session' } }); });
    expect(container.textContent).toContain('/work/B');
    expect(container.textContent).not.toContain('/work/A');
    expect(client.list).toHaveBeenCalledTimes(2);
  });
  it('recovers pending native work without retaining an exact command in the restarted renderer', async () => {
    const receipt = { commandId: 'saved-on-host', action: 'plugin-install' as const, state: 'uncertain' as const, application: 'new-session' as const };
    const list = vi.fn<AgentCapabilitiesClient['list']>().mockResolvedValue({ ok: true, value: { ...catalog(), extensionReceipts: [receipt] } });
    const manage = vi.fn<AgentCapabilitiesClient['manage']>().mockResolvedValue({ ok: true, value: receipt });
    render(<AgentCapabilitiesPanel client={{ list, manage }} providerId="codex" workspaceId="ws" />);
    await flush(); target('another@market');
    expect(button('Apply to PC settings').disabled).toBe(true);
    await click('Check saved result');
    expect(manage).toHaveBeenCalledWith(expect.objectContaining({ commandId: receipt.commandId, recovery: 'inspect', target: 'receipt' }));
    list.mockResolvedValue({ ok: true, value: { ...catalog(), extensionReceipts: [] } });
    await click('I checked the PC settings');
    expect(manage).toHaveBeenLastCalledWith(expect.objectContaining({ commandId: receipt.commandId, recovery: 'acknowledge' }));
    expect(button('Apply to PC settings').disabled).toBe(false);
  });
  it('preserves recovered encrypted skill references when revalidation cannot reach the host', async () => {
    const onSend = vi.fn(async () => ({ ok: true as const }));
    const list = vi.fn<AgentCapabilitiesClient['list']>().mockResolvedValue({ ok: false, code: 'unavailable', message: 'Host disconnected' });
    const draft = { text: '$review inspect changes', skills: [{ providerId: 'codex' as const, id: '/skills/review', name: 'Review', invocation: '$review' }] };
    render(<StructuredAgentSessionPanel capabilityClient={{ list, manage: vi.fn() }} sessionId="restored" title="Chat" providerId="codex" providerLabel="Codex" workspace={{ id: 'ws', label: 'Work', kind: 'local' }} permissionPreset="standard" state="idle" items={[]} draftState={draft} onSend={onSend} />);
    await flush();
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-composer-input"]')!;
    act(() => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    expect(input.value).toBe(draft.text);
    expect(onSend).not.toHaveBeenCalled();
  });
});
