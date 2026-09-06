import { DAEMON_PROTOCOL_VERSION, type DaemonSnapshot } from '../shared/daemon-protocol';

const stamp = { revision: 1, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z' };

/** Static inputs for production-component stories and regression tests. */
export const sessionStartSnapshot: DaemonSnapshot = {
  protocolVersion: DAEMON_PROTOCOL_VERSION, revision: 1, eventSequence: 1, generatedAt: stamp.updatedAt,
  runtime: { keepRunning: false, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
  projects: [{ ...stamp, id: 'project', name: 'EZTerminal', rootPath: 'C:\\Working\\EZTerminal', source: 'native' }],
  workspaces: [
    { ...stamp, id: 'main', projectId: 'project', name: 'Main checkout', kind: 'local', rootPath: 'C:\\Working\\EZTerminal' },
    { ...stamp, id: 'feature', projectId: 'project', name: 'Session UX', kind: 'worktree', rootPath: 'C:\\Working\\EZTerminal-worktrees\\session-ux' },
  ],
  sessions: [], agents: [], agentRelations: [], turns: [], transcriptHeads: [], approvals: [], providers: [], schedules: [], heartbeats: [],
};
