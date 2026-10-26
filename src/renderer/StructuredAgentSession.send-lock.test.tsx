// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import type { ChatComposerDraft } from '../shared/chat-message';
import { AppI18nProvider } from './i18n';
import { clearSessionViewStates } from './session-view-state';
import { StructuredAgentSessionPanel } from './StructuredAgentSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('one send per conversation across boxes', () => {
  it('a second box cannot send while the first still checks its skills', async () => {
    clearSessionViewStates();
    let finishCheck!: () => void;
    const list = vi.fn(() => new Promise<never>((resolve) => {
      finishCheck = () => resolve({ ok: true, value: { providerId: 'codex', workspaceId: 'w', models: [], items: [
        { id: 'review', kind: 'skill', name: 'review', invocation: '$review', enabled: true, actions: [] },
      ] } } as never);
    }));
    const client = { list, manage: vi.fn() } as never;
    const onSend = vi.fn(async () => ({ ok: true as const }));
    const draft: ChatComposerDraft = { text: '$review the diff', skills: [{ providerId: 'codex', id: 'review', name: 'review', invocation: '$review' }] };
    const box = (label: string) => (
      <div data-testid={label}>
        <StructuredAgentSessionPanel
          presentation={label === 'terminal' ? 'composer' : 'full'}
          sessionId="session-1" title="Review" providerId="codex" providerLabel="Codex"
          workspace={{ id: 'w', label: 'main', kind: 'local', path: 'C:\\p' }}
          permissionPreset="standard" state="idle" items={[]}
          capabilityClient={client} supportsMessageContext
          draftState={draft} onDraftChange={() => undefined}
          onSend={onSend}
        />
      </div>
    );
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<AppI18nProvider locale="en" languages={['en']}>{box('tab')}{box('terminal')}</AppI18nProvider>);
    });
    const send = (label: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${label}"] [data-testid="structured-agent-send"]`)!;
    await act(async () => { send('tab').click(); });
    await act(async () => { send('terminal').click(); });
    await act(async () => { finishCheck(); for (let index = 0; index < 10; index += 1) await Promise.resolve(); });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="terminal"]')!.textContent).toContain('already being sent');
    await act(async () => { root.unmount(); });
    host.remove();
  });
});
