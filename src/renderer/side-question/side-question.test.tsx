// @vitest-environment jsdom

import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentSideQuestionClient, AgentSideQuestionResult } from '../../shared/agent-side-question';
import { AppI18nProvider } from '../i18n';
import { clearSessionViewStates } from '../session-view-state';
import { StructuredAgentDraftPanel, StructuredAgentSessionPanel, storableDraft, type StructuredAgentSessionPanelProps } from '../StructuredAgentSession';
import { createSideQuestionClient } from './side-question-client';
import type { ChatComposerDraft } from '../chat-view-state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(node: ReactNode): void {
  act(() => root.render(<AppI18nProvider locale="en" languages={['en']}>{node}</AppI18nProvider>));
}

async function flush(): Promise<void> {
  await act(async () => { for (let index = 0; index < 4; index += 1) await Promise.resolve(); });
}

function type(control: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const composerInput = (): HTMLTextAreaElement => container.querySelector('[data-testid="structured-agent-composer-input"]')!;
const submitComposer = (): void => act(() => composerInput().closest('form')!.requestSubmit());
const btwButton = (): HTMLButtonElement | null => container.querySelector('[data-testid="structured-agent-btw"]');
const sideWindow = (): HTMLElement | null => container.querySelector('[data-testid="side-question-window"]');

function fakeClient(reply: (question: string) => AgentSideQuestionResult | Promise<AgentSideQuestionResult> = () => ({ ok: true, answer: 'It was **src/config.ts**.', synthetic: false })) {
  const calls: Array<{ question: string; history: unknown; signal: AbortSignal }> = [];
  const client: AgentSideQuestionClient = {
    ask: vi.fn(async (input, signal) => { calls.push({ question: input.question, history: input.history, signal }); return reply(input.question); }),
  };
  return { client, calls };
}

function panel(overrides: Partial<StructuredAgentSessionPanelProps> = {}): JSX.Element {
  return (
    <StructuredAgentSessionPanel
      sessionId="session-1"
      title="Conversation"
      providerId="claude"
      providerLabel="Claude"
      workspace={{ id: 'workspace-1', label: 'Demo', kind: 'local' }}
      model="claude-opus-5-5"
      permissionPreset="standard"
      state="idle"
      items={[]}
      onSend={async () => ({ ok: true })}
      {...overrides}
    />
  );
}

beforeEach(() => {
  clearSessionViewStates();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('/btw side questions in a conversation', () => {
  it('shows the button only for a live conversation of an AI that answers side questions', () => {
    const { client } = fakeClient();
    render(panel());
    expect(btwButton()).toBeNull();
    render(panel({ sideQuestion: { client, available: false } }));
    expect(btwButton()).toBeNull();
    render(panel({ providerId: 'openclaw', providerLabel: 'OpenClaw', sideQuestion: { client, available: true } }));
    expect(btwButton()).toBeNull();
    render(panel({ providerId: 'codex', providerLabel: 'Codex', sideQuestion: { client, available: true } }));
    expect(btwButton()).not.toBeNull();
    render(panel({ sideQuestion: { client, available: true } }));
    expect(btwButton()?.getAttribute('aria-label')).toBe('btw · side question');
  });

  it('asks /btw text without sending a turn, clears the box and opens a non-modal window', async () => {
    const { client, calls } = fakeClient();
    const onSend = vi.fn(async () => ({ ok: true as const }));
    render(panel({ onSend, sideQuestion: { client, available: true } }));
    type(composerInput(), '/btw which config file was it?');
    submitComposer();
    await flush();
    expect(onSend).not.toHaveBeenCalled();
    expect(calls.map((call) => [call.question, call.history])).toEqual([['which config file was it?', []]]);
    expect(composerInput().value).toBe('');
    expect(sideWindow()?.getAttribute('role')).toBe('dialog');
    expect(sideWindow()?.getAttribute('aria-modal')).toBe('false');
    expect(sideWindow()?.textContent).toContain('src/config.ts');
    expect(btwButton()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('sends earlier answers as history and keeps them in memory only', async () => {
    const { client, calls } = fakeClient((question) => ({ ok: true, answer: `answer to ${question}`, synthetic: false }));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(panel({ sideQuestion: { client, available: true } }));
    type(composerInput(), '/btw first?');
    submitComposer();
    await flush();
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="side-question-input"]')!;
    type(input, 'second?');
    act(() => input.closest('form')!.requestSubmit());
    await flush();
    expect(calls[1]).toMatchObject({ question: 'second?', history: [{ question: 'first?', answer: 'answer to first?' }] });
    expect(setItem.mock.calls.filter(([, value]) => String(value).includes('answer to'))).toEqual([]);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="side-question-clear"]')!.click());
    expect(sideWindow()?.textContent).not.toContain('answer to');
  });

  it('opens the window without asking for a bare /btw, and the button asks plain text only', async () => {
    const { client, calls } = fakeClient();
    render(panel({ sideQuestion: { client, available: true } }));
    type(composerInput(), '/btw');
    submitComposer();
    await flush();
    expect(sideWindow()).not.toBeNull();
    expect(calls).toHaveLength(0);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="side-question-close"]')!.click());
    expect(sideWindow()).toBeNull();
    type(composerInput(), 'what did we decide?');
    act(() => btwButton()!.click());
    await flush();
    expect(calls.map((call) => call.question)).toEqual(['what did we decide?']);
    expect(composerInput().value).toBe('');
  });

  it('never sends /btw while unavailable or in a draft', async () => {
    const { client, calls } = fakeClient();
    const onSend = vi.fn(async () => ({ ok: true as const }));
    render(panel({ onSend, sideQuestion: { client, available: false } }));
    type(composerInput(), '/btw anything?');
    submitComposer();
    await flush();
    expect(onSend).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(composerInput().value).toBe('/btw anything?');
    expect(document.body.textContent).toContain('Side questions open once you have sent this conversation a message');
    const onCreate = vi.fn(async () => ({ ok: true as const }));
    render(<StructuredAgentDraftPanel providers={[{ id: 'claude', label: 'Claude', models: [] }]}
      workspaces={[{ id: 'workspace-1', label: 'Workspace', kind: 'local' }]} initialDraftText="/btw hi" onCreate={onCreate} />);
    act(() => container.querySelector<HTMLFormElement>('form')!.requestSubmit());
    await flush();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('closes on Escape without stopping the running turn, moving focus in and back', async () => {
    const { client } = fakeClient();
    const onCancel = vi.fn(async () => ({ ok: true as const }));
    render(panel({ state: 'working', onCancel, sideQuestion: { client, available: true } }));
    act(() => btwButton()!.click());
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="side-question-input"]')!;
    expect(document.activeElement).toBe(input);
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await flush();
    expect(sideWindow()).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(btwButton());
  });

  it('resizes with the arrow keys within its limits', () => {
    const { client } = fakeClient();
    render(panel({ sideQuestion: { client, available: true } }));
    act(() => btwButton()!.click());
    const width = container.querySelector<HTMLElement>('[data-testid="side-question-resize-width"]')!;
    const before = Number(width.getAttribute('aria-valuenow'));
    act(() => { width.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(Number(width.getAttribute('aria-valuenow'))).toBe(Math.max(288, before - 8));
    for (let index = 0; index < 100; index += 1) act(() => { width.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(Number(width.getAttribute('aria-valuenow'))).toBe(288);
  });

  it('stops a pending side question and says so', async () => {
    let signal: AbortSignal | undefined;
    const client: AgentSideQuestionClient = { ask: (_input, abort) => { signal = abort; return new Promise(() => undefined); } };
    render(panel({ sideQuestion: { client, available: true } }));
    type(composerInput(), '/btw slow?');
    submitComposer();
    await flush();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="side-question-stop"]')!.click());
    expect(signal?.aborted).toBe(true);
    expect(sideWindow()?.textContent).toContain('Stopped.');
  });
});

describe('/btw and stored drafts', () => {
  it('keeps /btw text out of stored drafts, and the stored echo does not overwrite the box', async () => {
    const { client } = fakeClient();
    const stored: string[] = [];
    function Host(): JSX.Element {
      const [draft, setDraft] = useState<ChatComposerDraft | undefined>(undefined);
      return panel({ sideQuestion: { client, available: true }, draftState: draft,
        onDraftChange: (next) => { stored.push(next.text); setDraft(next); } });
    }
    render(<Host />);
    type(composerInput(), '/btw where is the SECRET_9 key?');
    await flush();
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.filter((text) => text.includes('SECRET_9'))).toEqual([]);
    expect(composerInput().value).toBe('/btw where is the SECRET_9 key?');
    type(composerInput(), 'an ordinary draft');
    await flush();
    expect(stored.at(-1)).toBe('an ordinary draft');
  });

  it('stores neither a /btw box nor a /btw draft parked under a queued edit', () => {
    expect(storableDraft({ text: '/btw secret?', selectionStart: 12, selectionEnd: 12 })).toEqual({ text: '', selectionStart: 0, selectionEnd: 0 });
    expect(storableDraft({ text: 'queued edit', parkedDraft: { text: '/btw secret?', selectionStart: 3, selectionEnd: 3 } }))
      .toEqual({ text: 'queued edit', parkedDraft: { text: '', selectionStart: 0, selectionEnd: 0 } });
    expect(storableDraft({ text: 'by the way, /btw is fine mid-text' })).toEqual({ text: 'by the way, /btw is fine mid-text' });
  });

  it('keeps a refused side question in the message box', async () => {
    const client: AgentSideQuestionClient = { ask: () => new Promise(() => undefined) };
    render(panel({ sideQuestion: { client, available: true } }));
    type(composerInput(), '/btw first?');
    submitComposer();
    await flush();
    expect(composerInput().value).toBe('');
    type(composerInput(), '/btw second?');
    submitComposer();
    await flush();
    expect(composerInput().value).toBe('/btw second?');
    type(composerInput(), 'third?');
    act(() => btwButton()!.click());
    await flush();
    expect(composerInput().value).toBe('third?');
  });
});

describe('createSideQuestionClient', () => {
  it('adds a request id and cancels it on abort', async () => {
    let resolve!: (result: AgentSideQuestionResult) => void;
    const api = {
      askSideQuestion: vi.fn(() => new Promise<AgentSideQuestionResult>((done) => { resolve = done; })),
      cancelSideQuestion: vi.fn(),
    };
    const client = createSideQuestionClient(api, () => 'request-1')!;
    const controller = new AbortController();
    const pending = client.ask({ sessionId: 's1', question: 'q', history: [] }, controller.signal);
    expect(api.askSideQuestion).toHaveBeenCalledWith({ requestId: 'request-1', sessionId: 's1', question: 'q', history: [] });
    controller.abort();
    expect(api.cancelSideQuestion).toHaveBeenCalledWith('request-1');
    resolve({ ok: true, answer: 'late', synthetic: false });
    await expect(pending).resolves.toEqual({ ok: false, code: 'cancelled' });
    expect(createSideQuestionClient({})).toBeUndefined();
  });
});
