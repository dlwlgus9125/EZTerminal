// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEntry, ConversationHistoryClient, ConversationPage } from '../shared/conversation-history';
import { ConversationHistoryPicker, type ConversationHistoryPickerProps } from './ConversationHistoryPicker';
import { AppI18nProvider } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const native: ConversationEntry = { conversationId: 'native-record', source: 'native', providerId: 'codex', projectId: 'project', projectTitle: 'Project', title: 'CLI investigation', preview: 'Previously discussed detail', createdAt: 1000, updatedAt: 2000, roots: ['/work/project'], historyId: 'opaque-history', archived: false, state: 'history', action: 'resume' };
const linked: ConversationEntry = { ...native, conversationId: 'app-record', title: 'Existing conversation', source: 'app', linkedSessionId: 'same-session', action: 'open' };
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
function clientFor(entries: readonly ConversationEntry[] = [native, linked]): ConversationHistoryClient {
  return {
    listConversations: vi.fn<ConversationHistoryClient['listConversations']>(async () => ({ ok: true, items: entries, nextCursor: null })),
    readConversation: vi.fn<ConversationHistoryClient['readConversation']>(async (conversationId) => {
      const entry = entries.find((item) => item.conversationId === conversationId)!;
      return { ok: true, entry, transcript: { historyId: conversationId, provider: 'codex', turns: [{ id: 'turn', status: 'completed', entries: [{ type: 'message', id: 'message', role: 'user', markdown: `Original messages: ${entry.title}` }] }], nextCursor: null } };
    }),
    prepareHistoryResume: vi.fn<ConversationHistoryClient['prepareHistoryResume']>(async ({ conversationId }) => ({ ok: true, entry: entries.find((entry) => entry.conversationId === conversationId)!, revision: 'revision-1', workspaceId: 'workspace', canResume: true, action: 'resume', permissionPreset: 'standard' })),
    resumeHistory: vi.fn<ConversationHistoryClient['resumeHistory']>(async () => ({ ok: true, sessionId: 'continued-session', alreadyLinked: false })),
  };
}
function render(props: Partial<ConversationHistoryPickerProps> = {}, key = 'picker'): void {
  act(() => root.render(<AppI18nProvider locale="en" languages={['en']}><ConversationHistoryPicker key={key} onOpenSession={vi.fn()} {...props} /></AppI18nProvider>));
}
function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label);
  if (!result) throw new Error(`Missing button ${label}`);
  return result;
}
async function select(title: string): Promise<void> { act(() => [...container.querySelectorAll<HTMLButtonElement>('.conversation-history__row')].find((candidate) => candidate.textContent?.includes(title))!.click()); await flush(); }
async function click(label: string): Promise<void> { act(() => button(label).click()); await flush(); }

describe('Unified conversation history', () => {
  it('loads project-scoped metadata and only previews a selected record without starting a conversation', async () => {
    const client = clientFor();
    render({ client, currentProjectId: 'project' }); await flush();
    expect(client.listConversations).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project', archived: 'include' }));
    expect(client.readConversation).not.toHaveBeenCalled();
    expect(client.prepareHistoryResume).not.toHaveBeenCalled();
    expect(client.resumeHistory).not.toHaveBeenCalled();
    await select('CLI investigation');
    expect(container.textContent).toContain('Original messages: CLI investigation');
    expect(client.prepareHistoryResume).toHaveBeenCalledWith({ conversationId: 'native-record' });
    expect(client.resumeHistory).not.toHaveBeenCalled();
  });

  it('opens on CLI history alone when asked for a project’s CLI records', async () => {
    const client = clientFor();
    render({ client, currentProjectId: 'project', initialSource: 'native' }); await flush();
    expect(client.listConversations).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project', source: 'native' }));
    const sourceFilter = [...container.querySelectorAll('select')].find((candidate) => [...candidate.options].some((option) => option.value === 'native'));
    expect(sourceFilter?.value).toBe('native');
  });

  it('continues a native record only after the explicit action using its prepared revision', async () => {
    const client = clientFor(); const onOpenSession = vi.fn();
    render({ client, initialConversationId: native.conversationId, onOpenSession }); await flush();
    await click('Continue in Agent');
    expect(client.resumeHistory).toHaveBeenCalledExactlyOnceWith({ conversationId: 'native-record', workspaceId: 'workspace', permissionPreset: 'standard', revision: 'revision-1', commandId: expect.stringMatching(/^history-/u) });
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith({ sessionId: 'continued-session', title: native.title, providerLabel: 'Codex' });
  });

  it('opens an already linked conversation with the same session identity and no resume mutation', async () => {
    const client = clientFor(); const onOpenSession = vi.fn();
    render({ client, onOpenSession }); await flush(); await select('Existing conversation'); await click('Open conversation');
    expect(onOpenSession).toHaveBeenCalledWith({ sessionId: 'same-session', title: linked.title, providerLabel: 'Codex' });
    expect(client.prepareHistoryResume).not.toHaveBeenCalled();
    expect(client.resumeHistory).not.toHaveBeenCalled();
  });

  it('keeps archived app continuation separate from reopening the old record', async () => {
    const stopped = { ...linked, archived: true, action: 'resume' as const, state: 'archived' };
    const client = clientFor([stopped]); const onOpenSession = vi.fn();
    render({ client, initialConversationId: stopped.conversationId, onOpenSession }); await flush(); await click('Continue in Agent');
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'continued-session' }));
    expect(client.resumeHistory).toHaveBeenCalledOnce();
  });

  it('preserves the exact unconfirmed command across closing and reopening the picker', async () => {
    const client = clientFor(); const onOpenSession = vi.fn();
    vi.mocked(client.resumeHistory).mockResolvedValueOnce({ ok: false, reason: 'unavailable', message: 'Disconnected' });
    render({ client, initialConversationId: native.conversationId, onOpenSession }); await flush(); await click('Continue in Agent');
    const original = vi.mocked(client.resumeHistory).mock.calls[0][0];
    expect(button('Check same request')).toBeDefined();
    render({ client, initialConversationId: native.conversationId, onOpenSession }, 'reopened'); await flush();
    await click('Check same request');
    expect(vi.mocked(client.resumeHistory).mock.calls[1][0]).toEqual(original);
    expect(onOpenSession).toHaveBeenCalledOnce();
  });

  it('does not let a late project response replace the newly selected project scope', async () => {
    let finishOld!: (value: ConversationPage) => void;
    const client = clientFor();
    vi.mocked(client.listConversations).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    render({ client, currentProjectId: 'old' }); await flush();
    render({ client, currentProjectId: 'new' }); await flush();
    await act(async () => finishOld({ ok: true, items: [{ ...native, title: 'Stale project record' }], nextCursor: null }));
    expect(container.textContent).not.toContain('Stale project record');
    expect(client.listConversations).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: 'new' }));
  });

  it('keeps the CLI alternative explicit and does not adopt the native session when it is selected', async () => {
    const client = clientFor(); const onOpenCliHistory = vi.fn();
    render({ client, initialConversationId: native.conversationId, onOpenCliHistory }); await flush(); await click('Continue in CLI');
    expect(onOpenCliHistory).toHaveBeenCalledWith(native);
    expect(client.resumeHistory).not.toHaveBeenCalled();
  });

  it('discards a late provider-filter response after the user selects another provider', async () => {
    let finishCodex!: (page: ConversationPage) => void;
    const client = clientFor();
    vi.mocked(client.listConversations).mockImplementation(async (query) => query?.providerId === 'codex'
      ? new Promise((resolve) => { finishCodex = resolve; })
      : { ok: true, items: query?.providerId === 'claude' ? [{ ...native, providerId: 'claude', title: 'Claude record' }] : [native], nextCursor: null });
    render({ client }); await flush();
    const label = [...container.querySelectorAll<HTMLLabelElement>('label')].find((entry) => entry.textContent === 'Provider')!;
    const filter = document.getElementById(label.htmlFor) as HTMLSelectElement;
    await act(async () => { filter.value = 'codex'; filter.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
    await act(async () => { filter.value = 'claude'; filter.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
    await act(async () => finishCodex({ ok: true, items: [{ ...native, title: 'Late Codex record' }], nextCursor: null }));
    expect(container.textContent).toContain('Claude record');
    expect(container.textContent).not.toContain('Late Codex record');
  });

  it('never exposes a late old-client preview or opens its completed resume in a new host scope', async () => {
    let finishPreview!: (result: Awaited<ReturnType<ConversationHistoryClient['readConversation']>>) => void;
    const oldClient = clientFor();
    const newEntry = { ...native, title: 'New PC conversation' };
    const newClient = clientFor([newEntry]);
    vi.mocked(oldClient.readConversation).mockImplementation(() => new Promise((resolve) => { finishPreview = resolve; }));
    const onOpenSession = vi.fn();
    render({ client: oldClient, initialConversationId: native.conversationId, onOpenSession }); await flush();
    render({ client: newClient, initialConversationId: native.conversationId, onOpenSession }); await flush();
    await act(async () => finishPreview({ ok: true, entry: native, transcript: { historyId: native.conversationId, provider: 'codex', turns: [{ id: 'old', status: 'completed', entries: [{ type: 'message', id: 'private', role: 'user', markdown: 'Private old-PC transcript' }] }], nextCursor: null } }));
    expect(container.textContent).not.toContain('Private old-PC transcript');
    expect(container.textContent).toContain('New PC conversation');
    expect(oldClient.prepareHistoryResume).not.toHaveBeenCalled();

    let finishResume!: (result: Awaited<ReturnType<ConversationHistoryClient['resumeHistory']>>) => void;
    vi.mocked(newClient.resumeHistory).mockImplementation(() => new Promise((resolve) => { finishResume = resolve; }));
    await click('Continue in Agent');
    render({ client: oldClient, onOpenSession }); await flush();
    await act(async () => finishResume({ ok: true, sessionId: 'old-scope-adoption', alreadyLinked: false }));
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('explains missing folders and disables continuation without discarding the readable transcript', async () => {
    const client = clientFor();
    vi.mocked(client.prepareHistoryResume).mockResolvedValue({ ok: true, entry: native, revision: 'revision', canResume: false, action: 'unavailable', blockedReason: 'missing-root', permissionPreset: 'standard' });
    render({ client, initialConversationId: native.conversationId }); await flush();
    expect(container.textContent).toContain('recorded working folder is missing');
    expect(container.textContent).toContain('Original messages: CLI investigation');
    expect(button('Continue in Agent').disabled).toBe(true);
  });

  it('provides an update-needed state for older hosts rather than an empty-history success', async () => {
    render(); await flush();
    expect(container.textContent).toContain('Update EZTerminal on the connected PC');
    expect(container.textContent).not.toContain('There are no saved conversations');
  });

  it('returns from mobile preview to the existing list without issuing a continuation', async () => {
    const client = clientFor();
    render({ client, variant: 'mobile' }); await flush(); await select('CLI investigation');
    expect(container.querySelector('.conversation-history__browser')?.hasAttribute('hidden')).toBe(true);
    await click('Conversation list');
    expect(container.querySelector('.conversation-history__browser')?.hasAttribute('hidden')).toBe(false);
    expect(client.resumeHistory).not.toHaveBeenCalled();
  });

  it.each(['app', 'native'] as const)('prepends earlier %s messages from the backward history cursor', async (source) => {
    const entry = { ...linked, source };
    const client = clientFor([entry]);
    vi.mocked(client.readConversation).mockImplementation(async (_conversationId, cursor) => ({ ok: true, entry, transcript: {
      historyId: entry.conversationId, provider: 'codex', nextCursor: cursor ? null : 'earlier-page',
      turns: [{ id: cursor ? 'older' : 'newer', status: 'completed', entries: [{ type: 'message', id: cursor ? 'older-message' : 'newer-message', role: 'user', markdown: cursor ? 'Earlier message' : 'Latest message' }] }],
    } }));
    render({ client, initialConversationId: entry.conversationId }); await flush(); await click('Load earlier messages');
    expect(client.readConversation).toHaveBeenLastCalledWith(entry.conversationId, 'earlier-page', 20);
    expect([...container.querySelectorAll('.conversation-history__message p')].map((item) => item.textContent)).toEqual(['Earlier message', 'Latest message']);
    expect(container.textContent).not.toContain('Load earlier messages');
    expect(client.resumeHistory).not.toHaveBeenCalled();
  });
});
