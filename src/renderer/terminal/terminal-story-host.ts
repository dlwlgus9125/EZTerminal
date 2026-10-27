import type { ChatStateResult, ChatStateScope, ChatStateWrite, ChatStateSnapshot } from '../../shared/chat-state';
import type { DaemonSnapshot } from '../../shared/daemon-protocol';
import type { InterpreterFrame } from '../../shared/ipc';
import type { TerminalCompletionRequest, TerminalCompletionResult } from '../../shared/terminal-completion';
import { shellSnapshot } from '../shell/shell-fixtures';

/**
 * A fake host for terminal stories (the desktop pane and the phone terminal): commands "run" by
 * sending interpreter frames over a real MessagePort, and conversation drafts live in memory.
 * Story data only; production code never imports this file.
 */

export const CWD = 'C:\\Working\\EZTerminal';
export const START = new Date(2026, 9, 27, 14, 20, 0).getTime();

/** Scripted output per command: text rows (each a line) and the exit code. */
export const OUTPUTS: Record<string, { readonly lines: readonly string[]; readonly exitCode: number; readonly tookMs: number }> = {
  'git status --short': { lines: [' M src/renderer/TerminalPane.tsx', ' M src/renderer/index.css', '?? src/renderer/terminal/TerminalAiDock.tsx'], exitCode: 0, tookMs: 240 },
  'git log --oneline -3': { lines: ['9a8385b feat(terminal): Ctrl+. AI input', 'b566754 feat(terminal): instrument blocks', '556962c feat(terminal): Tab completion engine'], exitCode: 0, tookMs: 180 },
};

export function snapshotWithProvider(): DaemonSnapshot {
  const base = shellSnapshot();
  const record = { revision: 1, createdAt: base.generatedAt, updatedAt: base.generatedAt };
  return {
    ...base,
    providers: [{ ...record, id: 'claude', displayName: 'Claude', protocol: 'claude-agent-sdk', executablePath: 'claude', executableVersion: '2', argv: [], environmentVariableNames: [], capabilities: [], reviewDigest: 'review', enabled: true, health: 'ready' }],
    // A conversation that finished its turn and waits for the next message.
    agents: base.agents.map((agent) => (agent.sessionId === 's-font' ? { ...agent, state: 'idle', model: 'claude-opus' } : agent)),
  } as DaemonSnapshot;
}

/** A clock that moves on by each command's own time, so start times and durations read the same every run. */
export function scriptedClock(): { readonly now: () => number; readonly ran: (tookMs: number) => void } {
  let current = START;
  return { now: () => current, ran: (tookMs) => { current += tookMs; } };
}

export function storyHost(clock: ReturnType<typeof scriptedClock>) {
  const drafts = new Map<string, ChatStateSnapshot>();
  const key = (scope: ChatStateScope) => `${scope.projectId}\0${scope.sessionId}\0${scope.kind ?? ''}`;
  return {
    openSessionSurface: async (surfaceId: string) => ({
      ok: true as const,
      binding: { surfaceId, bindingId: `binding:${surfaceId}`, role: 'owner' as const, session: { sessionId: 'story-terminal', cwd: CWD, createdAt: START } },
    }),
    prepareSessionSurfaceClose: async () => ({ ok: true as const, prepared: { closeToken: 'story-close', items: [] } }),
    commitSessionSurfaceClose: async () => ({ ok: true as const, keptSessionIds: [] }),
    releaseSessionSurface: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listRuns: async () => [],
    onRunStarted: () => () => undefined,
    onSessionDead: () => () => undefined,
    onSessionRecovered: () => () => undefined,
    attachRun: async () => undefined,
    runCommand: async (text: string, runId: string) => {
      const output = OUTPUTS[text] ?? { lines: [`${text}: not in this story`], exitCode: 1, tookMs: 120 };
      const channel = new MessageChannel();
      const rows = output.lines.map((line, index) => ({ value: index < output.lines.length - 1 ? `${line}\n` : line }));
      const send = (frame: InterpreterFrame): void => channel.port1.postMessage(frame);
      channel.port1.onmessage = (event: MessageEvent<{ type: string; start?: number; count?: number }>) => {
        if (event.data.type !== 'requestRows' && event.data.type !== 'setViewport') return;
        const start = event.data.start ?? 0;
        send({ type: 'chunk', start, rows: rows.slice(start, start + (event.data.count ?? rows.length)) });
      };
      window.postMessage({ _ezPort: runId }, window.location.origin, [channel.port2]);
      setTimeout(() => {
        send({ type: 'start', commandText: text, cwd: CWD, executionKind: 'local' });
        send({ type: 'schema', shape: 'text', columns: [{ name: 'value', type: 'html' }] });
        send({ type: 'progress', count: rows.length, done: true });
        clock.ran(output.tookMs);
        send({ type: 'end', exitCode: output.exitCode, cwd: CWD });
      }, 30);
    },
    chatStateRead: async (scope: ChatStateScope): Promise<ChatStateResult> => ({
      ok: true, snapshot: drafts.get(key(scope)) ?? { version: 1, scope, revision: 0, state: { draft: { text: '' } }, updatedAt: null },
    }),
    chatStateWrite: async (scope: ChatStateScope, request: ChatStateWrite): Promise<ChatStateResult> => {
      const current = drafts.get(key(scope));
      const revision = (current?.revision ?? 0);
      if (request.expectedRevision !== revision) return { ok: false, error: 'stale', revision, message: 'conflict' };
      const next = { version: 1 as const, scope, revision: revision + 1, state: request.state, updatedAt: new Date(START).toISOString() };
      drafts.set(key(scope), next);
      return { ok: true, snapshot: next };
    },
  } as unknown as Window['ezterminal'];
}

/** Tab completion of `cd s…` in the story's folder. */
export const storyDesktop = {
  completeTerminalLine: async (request: TerminalCompletionRequest): Promise<TerminalCompletionResult> => {
    const start = request.line.lastIndexOf(' ', request.caret - 1) + 1;
    const word = request.line.slice(start, request.caret).toLowerCase();
    const candidates = ['scripts\\', 'src\\', 'storybook-static\\']
      .filter((name) => name.startsWith(word))
      .map((name) => ({ label: name, kind: 'directory' as const, insertText: name }));
    if (candidates.length === 0) return { ok: false, reason: 'none' };
    return { ok: true, replaceStart: start, replaceEnd: request.caret, commonText: candidates.length === 1 ? candidates[0]!.insertText : request.line.slice(start, request.caret), candidates, truncated: false };
  },
} as unknown as Window['ezterminalDesktop'];
