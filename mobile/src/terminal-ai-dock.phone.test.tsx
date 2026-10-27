import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonCommand, DaemonCommandReceipt, DaemonSnapshot } from '../../src/shared/daemon-protocol';
import { AppI18nProvider } from '../../src/renderer/i18n';
import { createCapabilityAccess } from '../../src/renderer/capability-access';
import { buildBlockExcerpt, terminalOutputAttachment } from '../../src/renderer/terminal/block-excerpt';
import { createTerminalAiHost } from '../../src/renderer/terminal/terminal-ai-host';
import { TerminalAiDock, type TerminalAiWiring } from '../../src/renderer/terminal/TerminalAiDock';
import type { SecureStorageLike } from './mobile-agent-create-recovery-store';
import { MobileChatStateStore } from './mobile-chat-state-store';
import { PHONE_PRINCIPAL, phoneChatStateAccess } from './phone-conversation-access';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class SecureMemory implements SecureStorageLike {
  readonly values = new Map<string, string>();
  async getPlatform() { return { value: 'android' }; }
  async keys() { return { value: [...this.values.keys()] }; }
  async get({ key }: { key: string }) { return { value: this.values.get(key)! }; }
  async set({ key, value }: { key: string; value: string }) { this.values.set(key, value); return { value: true }; }
  async remove({ key }: { key: string }) { return { value: this.values.delete(key) }; }
}

const NOW = '2026-10-27T08:00:00.000Z';
const revision = { revision: 1, createdAt: NOW, updatedAt: NOW };
const snapshot: DaemonSnapshot = {
  protocolVersion: 12, revision: 2, eventSequence: 0, generatedAt: NOW,
  runtime: { keepRunning: false, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
  projects: [{ ...revision, id: 'project', name: 'Project', source: 'native' }],
  workspaces: [{ ...revision, id: 'workspace', projectId: 'project', name: 'Main', kind: 'local', rootPath: 'C:\\Project' }],
  sessions: [{ ...revision, id: 'chat', projectId: 'project', workspaceId: 'workspace', kind: 'agent', title: 'Fix the login', state: 'running', source: 'structured' }],
  agents: [{ ...revision, sessionId: 'chat', providerId: 'codex', providerSessionId: 'p-1', state: 'idle', permissionPreset: 'standard', queuedTurnCount: 0, orchestrationEnabled: true }],
  providers: [{ ...revision, id: 'codex', displayName: 'Codex', protocol: 'codex-app-server', executablePath: 'codex', executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: [], reviewDigest: 'r', enabled: true, health: 'ready' }],
  agentRelations: [], turns: [], transcriptHeads: [], approvals: [], schedules: [], heartbeats: [],
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('the terminal AI box on the phone', () => {
  it('puts a finished block into the conversation draft as a chip and keeps it', async () => {
    const secure = new SecureMemory();
    const send = vi.fn(async (command: DaemonCommand): Promise<DaemonCommandReceipt> => ({ ok: true, status: 'applied', commandId: command.commandId, revision: 3, eventSequence: 1 }));
    const transport = {
      getRemoteToken: async () => 'test-pc', getDaemonSnapshot: async () => snapshot, sendDaemonCommand: send,
      listDaemonProviderModels: async () => ({ ok: true, value: [] }), negotiatedRemoteProtocolVersion: 17,
      agentCapabilitiesList: async () => ({ ok: true, value: { items: [] } }), agentCapabilitiesManage: async () => ({ ok: true }),
    } as unknown as WsEzTerminalTransport;
    const access = phoneChatStateAccess(transport, { secure, store: new MobileChatStateStore(secure) });
    const wiring: TerminalAiWiring = {
      chatStateAccess: access,
      capabilities: createCapabilityAccess({ readCore: () => transport, readDesktop: () => undefined }),
      principal: PHONE_PRINCIPAL,
      start: { access: { history: transport, getSnapshot: async () => snapshot, sendCommand: send, principal: PHONE_PRINCIPAL } as never, storage: access,
        capabilityClient: { list: transport.agentCapabilitiesList, manage: transport.agentCapabilitiesManage } as never },
    };
    const host = createTerminalAiHost({ openConversation: () => undefined, notifySent: () => undefined });
    host.set(snapshot);
    const attachment = terminalOutputAttachment('run-1', 'echo hi', buildBlockExcerpt({ command: 'echo hi', cwd: null, status: 'done', exitCode: 0, output: 'hi\n' }), 'Terminal');
    let pending = [{ runId: 'run-1', attachment }];
    const settled = vi.fn((applied: readonly string[]) => { pending = pending.filter((item) => !applied.includes(item.runId)); show(); });
    const show = (): void => root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <TerminalAiDock variant="mobile" wiring={wiring} host={host} target={{ kind: 'conversation', sessionId: 'chat', title: 'Fix the login', providerId: 'codex' }} pending={pending}
          onPendingSettled={settled} onSent={() => undefined} onStarted={() => undefined} onNewConversation={() => undefined} />
      </AppI18nProvider>,
    );
    act(() => show());
    // Every wait inside act (vi.waitFor polls outside it, where an update would warn on a slow runner).
    for (let attempt = 0; attempt < 200 && settled.mock.calls.length === 0; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    expect(settled).toHaveBeenCalled();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(container.querySelectorAll('[data-testid="terminal-ai-chip"]')).toHaveLength(1);
  });
});
