import type { WsLike } from '../ws-ezterminal';

type Handler = (...args: never[]) => void;
/** Frozen r4 host wire behavior: validates 14/13/12, ignores unknown auth fields,
 * echoes protocolVersion, and exposes only the existing daemon/history/PTY APIs.
 * Deliberately imports no current protocol negotiator so a fake auth-ok cannot
 * conceal an incompatible first request from the new mobile transport. */
export class R4RemoteHostSocket implements WsLike {
  readonly sent: Record<string, unknown>[] = [];
  readyState = 0;
  private authed = false;
  private readonly handlers: Record<'open' | 'message' | 'close' | 'error', Handler[]> = { open: [], message: [], close: [], error: [] };
  constructor() { queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: never): void { this.handlers[type].push(listener as Handler); }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  private emit(type: 'open' | 'message' | 'close', value?: unknown): void { for (const handler of this.handlers[type]) handler(value as never); }
  private reply(value: unknown): void { queueMicrotask(() => { if (this.readyState === 1) this.emit('message', { data: JSON.stringify(value) }); }); }
  send(raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>; this.sent.push(message);
    if (!this.authed) {
      const identity = message.clientIdentity as { clientId?: unknown; clientName?: unknown; platform?: unknown } | undefined;
      const compatible = [14, 13, 12].includes(message.protocolVersion as number)
        && typeof message.clientVersion === 'string' && message.clientVersion.trim().length > 0
        && identity?.platform === 'android' && typeof identity.clientId === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(identity.clientId)
        && typeof identity.clientName === 'string' && identity.clientName.trim().length > 0;
      if (message.kind !== 'auth' || message.token !== 'paired-token' || !compatible) {
        this.reply({ kind: 'auth-fail', reason: message.token !== 'paired-token' ? 'invalid-token' : 'incompatible-protocol', supportedProtocolVersion: 14, supportedProtocolVersions: [14, 13, 12], hostVersion: '2.0.0-r4' }); return;
      }
      this.authed = true;
      this.reply({ kind: 'auth-ok', protocolVersion: message.protocolVersion, hostVersion: '2.0.0-r4' }); return;
    }
    const requestId = message.requestId;
    switch (message.kind) {
      case 'daemon-snapshot-get':
        this.reply({ kind: 'daemon-snapshot', requestId, snapshot: { protocolVersion: 12, revision: 1, eventSequence: 1, generatedAt: '2026-10-14T00:00:00.000Z',
          runtime: { keepRunning: false, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
          projects: [], workspaces: [], sessions: [], agents: [], agentRelations: [], turns: [], transcriptHeads: [], approvals: [], providers: [], schedules: [], heartbeats: [] } }); break;
      case 'agent-projects-list':
        this.reply({ kind: 'agent-projects-list-reply', requestId, result: { items: [{ projectId: 'project', name: 'Existing project', primaryRoot: '/work', additionalRoots: [], pinned: false, saved: true, sessionCount: 1, providers: ['codex'], lastActiveAt: 2 }], nextCursor: null } }); break;
      case 'agent-history-sessions':
        this.reply({ kind: 'agent-history-sessions-reply', requestId, result: { items: [{ historyId: 'codex_opaque', projectId: 'project', provider: 'codex', title: 'Saved CLI conversation', preview: 'Original prompt', createdAt: 1, updatedAt: 2, roots: ['/work'], source: 'cli' }], nextCursor: null } }); break;
      case 'agent-history-read':
        this.reply({ kind: 'agent-history-read-reply', requestId, result: { historyId: 'codex_opaque', provider: 'codex', turns: [{ id: 'turn', status: 'completed', entries: [{ type: 'message', id: 'item', role: 'user', markdown: 'Original saved conversation' }] }], nextCursor: null } }); break;
      case 'agent-history-prepare-resume':
        this.reply({ kind: 'agent-history-prepare-resume-reply', requestId, result: { historyId: 'codex_opaque', provider: 'codex', recordedRoots: ['/work'], currentRoots: ['/work'], rootsMatch: true,
          missingRecordedRoots: [], missingCurrentRoots: [], canResume: true, revision: 'r4-prepared' } }); break;
      case 'agent-history-start-resume': {
        const request = message.request as { historyId?: string; revision?: string; rootChoice?: string };
        this.reply({ kind: 'agent-history-start-resume-reply', requestId, result: request.historyId === 'codex_opaque' && request.revision === 'r4-prepared' && request.rootChoice === 'recorded'
          ? { ok: true } : { ok: false, reason: 'invalid' } }); break;
      }
    }
  }
}
