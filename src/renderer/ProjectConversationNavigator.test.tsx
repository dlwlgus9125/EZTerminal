// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonEvent, DaemonSnapshot } from '../shared/daemon-protocol';
import type { DaemonAgentSessionListAccess } from './DaemonAgentSessions';
import { ProjectConversationNavigator } from './ProjectConversationNavigator';
import { sessionStartSnapshot } from './session-start.fixtures';
import { AppI18nProvider } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const eventBase = { protocolVersion: sessionStartSnapshot.protocolVersion, eventId: 'event', revision: 1, sequence: 2, occurredAt: sessionStartSnapshot.generatedAt };
describe('project navigation observation', () => {
  let element: HTMLDivElement;
  let root: Root;
  beforeEach(() => { window.localStorage.clear(); element = document.createElement('div'); document.body.append(element); root = createRoot(element); });
  afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
  const render = async (access: DaemonAgentSessionListAccess): Promise<void> => {
    await act(async () => root.render(<AppI18nProvider locale="en" languages={['en']}><ProjectConversationNavigator projects={[]} access={{}} daemonAccess={access} onOpenProject={vi.fn()} onOpenSession={vi.fn()} onOpenTerminal={vi.fn()} /></AppI18nProvider>));
  };
  it('ignores streamed transcript events while refreshing changes to session metadata', async () => {
    let listener!: (event: DaemonEvent) => void;
    const getSnapshot = vi.fn(async () => sessionStartSnapshot);
    await render({ getSnapshot, getAvailability: vi.fn(), observeEvents: next => { listener = next; return () => undefined; } });
    await act(async () => { for (let sequence = 2; sequence < 102; sequence += 1) listener({ ...eventBase, sequence, kind: 'transcript.appended', payload: { sessionId: 'chat', fromSequence: sequence, toSequence: sequence } }); });
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    await act(async () => listener({ ...eventBase, kind: 'entity.upserted', payload: { entityType: 'agent', entityId: 'chat' } }));
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });
  it('coalesces metadata notifications received while a snapshot is loading', async () => {
    let listener!: (event: DaemonEvent) => void;
    let resolve!: (snapshot: DaemonSnapshot) => void;
    const initial = new Promise<DaemonSnapshot>(done => { resolve = done; });
    const getSnapshot = vi.fn().mockReturnValueOnce(initial).mockResolvedValue(sessionStartSnapshot);
    await render({ getSnapshot, getAvailability: vi.fn(), observeEvents: next => { listener = next; return () => undefined; } });
    await act(async () => {
      for (let sequence = 2; sequence < 12; sequence += 1) listener({ ...eventBase, sequence, kind: 'entity.upserted', payload: { entityType: 'session', entityId: 'chat' } });
    });
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    await act(async () => resolve(sessionStartSnapshot));
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });
});
