// @vitest-environment jsdom
import { createDockview, type DockviewApi } from 'dockview-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DockWindowCoordinator } from '../dock-window-coordinator';
import { AgentResultsDock, resultsPanelId } from './agent-results-dock';
import { readResultsTabPrefs, resetResultsTabPrefsForTests } from './results-prefs';
import { publishResultsDock, readResultsNavigation, readResultsSource, resetResultsSourcesForTests } from './results-source-store';

class StubResizeObserver {
  observe(): void { /* jsdom has no layout */ }
  unobserve(): void { /* jsdom has no layout */ }
  disconnect(): void { /* jsdom has no layout */ }
}

interface Harness {
  readonly api: DockviewApi;
  readonly dock: AgentResultsDock;
  transaction: boolean;
}

function harness(width = 1600): Harness {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= StubResizeObserver;
  const element = document.createElement('div');
  document.body.append(element);
  const api = createDockview(element, {
    createComponent: () => {
      const content = document.createElement('div');
      return { element: content, init: () => undefined };
    },
  });
  api.layout(width, 900);
  const state = { transaction: false } as Harness;
  const dock = new AgentResultsDock(api, new DockWindowCoordinator(api), {
    isLayoutTransactionActive: () => state.transaction,
    title: (owner) => `Results · ${owner}`,
  });
  return Object.assign(state, { api, dock });
}

function conversation(api: DockviewApi, id: string, sessionId: string, position?: Parameters<DockviewApi['addPanel']>[0]['position']) {
  const panel = api.addPanel({ id, component: 'agent-session', title: id, params: { historyId: sessionId }, ...(position ? { position } : {}) });
  publishResultsDock(id, {
    sessionId, title: id, providerLabel: 'Codex', items: [], children: [], transcriptFloor: 0, loaded: true,
    baselineSequence: 0, historyOnly: false, turnActive: false,
  });
  return panel;
}

describe('Results tab placement and lifecycle (real Dockview)', () => {
  beforeEach(() => { localStorage.clear(); resetResultsTabPrefsForTests(); });
  afterEach(() => { resetResultsSourcesForTests(); document.body.replaceChildren(); });

  it('opens beside a wide conversation without taking the active panel, showing its content', () => {
    const { api, dock } = harness(1600);
    const owner = conversation(api, 'agent-session-a', 's-a');
    owner.api.setActive();
    expect(dock.open('agent-session-a')).toBe(true);
    const results = api.getPanel(resultsPanelId('agent-session-a'))!;
    expect(results.group).not.toBe(owner.group);
    expect(results.group.activePanel).toBe(results);
    expect(api.activePanel).toBe(owner);
    expect(results.title).toBe('Results · agent-session-a');
  });

  it('opens as a tab next to a narrow conversation and does not cover it', () => {
    const { api, dock } = harness(700);
    const owner = conversation(api, 'agent-session-a', 's-a');
    owner.api.setActive();
    dock.open('agent-session-a');
    const results = api.getPanel(resultsPanelId('agent-session-a'))!;
    expect(results.group).toBe(owner.group);
    expect(owner.group.activePanel).toBe(owner);
  });

  it('a person opening it brings it forward; a navigation target is passed on', () => {
    const { api, dock } = harness(1600);
    conversation(api, 'agent-session-a', 's-a').api.setActive();
    dock.open('agent-session-a', { activate: true, target: { section: 'files', path: 'notes.md' } });
    expect(api.activePanel?.id).toBe(resultsPanelId('agent-session-a'));
    expect(readResultsNavigation('agent-session-a')).toMatchObject({ section: 'files', path: 'notes.md' });
  });

  it('every conversation shares one Results group, and the active conversation\'s tab comes forward', () => {
    const { api, dock } = harness(1600);
    const a = conversation(api, 'agent-session-a', 's-a');
    const b = conversation(api, 'agent-session-b', 's-b', { referencePanel: 'agent-session-a', direction: 'within' });
    a.api.setActive();
    dock.open('agent-session-a');
    b.api.setActive();
    dock.open('agent-session-b');
    const resultsA = api.getPanel(resultsPanelId('agent-session-a'))!;
    const resultsB = api.getPanel(resultsPanelId('agent-session-b'))!;
    expect(resultsA.group).toBe(resultsB.group);
    expect(resultsB.group.activePanel).toBe(resultsB);
    a.api.setActive();
    expect(resultsA.group.activePanel).toBe(resultsA);
    expect(api.activePanel).toBe(a);
  });

  it('auto-opens, never again after the person closes it, and waits while the conversation is hidden', () => {
    const { api, dock } = harness(1600);
    const a = conversation(api, 'agent-session-a', 's-a');
    const b = conversation(api, 'agent-session-b', 's-b', { referencePanel: 'agent-session-a', direction: 'within' });
    b.api.setActive();
    dock.requestAutoOpen('agent-session-a', 's-a');
    expect(dock.isOpen('agent-session-a')).toBe(false);
    a.api.setActive();
    return Promise.resolve().then(() => {
      expect(dock.isOpen('agent-session-a')).toBe(true);
      api.getPanel(resultsPanelId('agent-session-a'))!.api.close();
      expect(readResultsTabPrefs('s-a').dismissed).toBe(true);
      dock.requestAutoOpen('agent-session-a', 's-a');
      expect(dock.isOpen('agent-session-a')).toBe(false);
      // The person can still open it.
      expect(dock.open('agent-session-a')).toBe(true);
    });
  });

  it('closing during a layout restore is not the person\'s choice', () => {
    const state = harness(1600);
    conversation(state.api, 'agent-session-a', 's-a').api.setActive();
    state.dock.open('agent-session-a');
    state.transaction = true;
    state.api.getPanel(resultsPanelId('agent-session-a'))!.api.close();
    expect(readResultsTabPrefs('s-a').dismissed).toBe(false);
  });

  it('closing the conversation is not closing Results: reopened later, a new result opens it again', async () => {
    const { api, dock } = harness(1600);
    conversation(api, 'agent-session-a', 's-a').api.setActive();
    dock.requestAutoOpen('agent-session-a', 's-a');
    expect(dock.isOpen('agent-session-a')).toBe(true);
    api.getPanel('agent-session-a')!.api.close();
    await Promise.resolve();
    conversation(api, 'agent-session-b', 's-a').api.setActive();
    dock.requestAutoOpen('agent-session-b', 's-a');
    expect(dock.isOpen('agent-session-b')).toBe(true);
  });

  it('closes with its conversation and forgets what the conversation published', async () => {
    const { api, dock } = harness(1600);
    const owner = conversation(api, 'agent-session-a', 's-a');
    owner.api.setActive();
    dock.open('agent-session-a');
    owner.api.close();
    await Promise.resolve();
    expect(api.getPanel(resultsPanelId('agent-session-a'))).toBeUndefined();
    expect(readResultsSource('agent-session-a')).toBeUndefined();
    expect(readResultsTabPrefs('s-a').dismissed).toBe(false);
  });

  it('keeps keyboard focus where it was when it opens on its own', () => {
    const { api, dock } = harness(1600);
    conversation(api, 'agent-session-a', 's-a').api.setActive();
    const composer = document.createElement('textarea');
    document.body.append(composer);
    composer.focus();
    dock.open('agent-session-a');
    expect(document.activeElement).toBe(composer);
  });

  it('a UI scale above 100% needs a wider conversation before splitting', () => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= StubResizeObserver;
    const element = document.createElement('div');
    document.body.append(element);
    const api = createDockview(element, { createComponent: () => ({ element: document.createElement('div'), init: () => undefined }) });
    api.layout(1000, 800);
    const dock = new AgentResultsDock(api, new DockWindowCoordinator(api), { isLayoutTransactionActive: () => false, uiScale: () => 1.3 });
    const owner = conversation(api, 'agent-session-a', 's-a');
    owner.api.setActive();
    dock.open('agent-session-a');
    expect(api.getPanel(resultsPanelId('agent-session-a'))!.group).toBe(owner.group);
  });
});
