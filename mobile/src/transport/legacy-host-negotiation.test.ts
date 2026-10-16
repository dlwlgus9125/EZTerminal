import { afterEach, describe, expect, it, vi } from 'vitest';
import { WsEzTerminalTransport } from './ws-ezterminal';
import { R4RemoteHostSocket } from './fixtures/r4-remote-host';

let transport: WsEzTerminalTransport | undefined;
afterEach(() => { transport?.disconnect(); transport = undefined; });
describe('new mobile to frozen r4 host wire compatibility', () => {
  it('uses one baseline offer to list/read the unified picker and explicitly continue through the existing PTY API', async () => {
    const sockets: R4RemoteHostSocket[] = [];
    transport = new WsEzTerminalTransport({ url: 'ws://r4-host', token: 'paired-token',
      clientIdentity: { clientId: '00000000-0000-4000-8000-000000000001', clientName: 'New phone', platform: 'android' },
      createSocket: () => { const socket = new R4RemoteHostSocket(); sockets.push(socket); return socket; } });
    await vi.waitFor(() => expect(transport!.isAuthed).toBe(true));
    expect(sockets[0].sent[0]).toMatchObject({ kind: 'auth', protocolVersion: 12, supportedProtocolVersions: [16, 15, 14, 13, 12] });
    expect(transport.negotiatedRemoteProtocolVersion).toBe(12);
    const list = await transport.listConversations({ source: 'native' }); if (!list.ok) throw new Error(list.message);
    expect(list.items).toHaveLength(1); expect(list.items[0]).toMatchObject({ source: 'native', historyId: 'codex_opaque', action: 'unavailable' });
    expect(await transport.readConversation(list.items[0].conversationId)).toMatchObject({ ok: true, transcript: { turns: [{ entries: [{ markdown: 'Original saved conversation' }] }] } });
    expect(await transport.prepareHistoryResume({ conversationId: list.items[0].conversationId })).toMatchObject({ ok: false, reason: 'unsupported' });
    const preparation = await transport.prepareAgentResume(list.items[0].historyId!); expect(preparation?.canResume).toBe(true);
    expect(await transport.startAgentResume({ historyId: list.items[0].historyId!, sessionId: 'existing-pty-target', runId: 'explicit-cli-run', rootChoice: 'recorded', revision: preparation!.revision })).toEqual({ ok: true });
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent.filter(message => message.kind === 'auth')).toHaveLength(1);
    expect(sockets[0].sent.some(message => String(message.kind).startsWith('conversation-history-'))).toBe(false);
    expect(sockets[0].sent.filter(message => message.kind === 'agent-history-start-resume')).toHaveLength(1);
  });
});
