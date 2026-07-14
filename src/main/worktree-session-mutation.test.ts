import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { InterpreterToMain, MainToInterpreter } from '../shared/ipc';
import { AsyncMutationGate } from './async-mutation-gate';
import {
  InterpreterBroker,
  type BrokerInterpreter,
} from './interpreter-broker';
import { GitRunner, WorktreeService } from './worktree-service';
import { SessionWorktreeGuard } from './session-worktree-guard';

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function makeRepo(): { repo: string; userData: string } {
  const base = mkdtempSync(path.join(tmpdir(), 'ezterm-worktree-session-race-'));
  const repo = path.join(base, 'source');
  const userData = path.join(base, 'user-data');
  mkdirSync(repo);
  mkdirSync(userData);
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'tests@example.invalid']);
  git(repo, ['config', 'user.name', 'EZTerminal Tests']);
  writeFileSync(path.join(repo, 'README.md'), 'initial\n', 'utf8');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'initial']);
  return { repo, userData };
}

class ObservedGate extends AsyncMutationGate {
  callCount = 0;

  override runExclusive<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    this.callCount += 1;
    return super.runExclusive(operation);
  }
}

class FakeInterpreter implements BrokerInterpreter {
  readonly posted: MainToInterpreter[] = [];
  private readonly messageListeners = new Set<(message: InterpreterToMain) => void>();
  private readonly exitListeners = new Set<(code?: number) => void>();

  constructor(private readonly onPost?: (message: MainToInterpreter) => void) {}

  postMessage(message: MainToInterpreter): void {
    this.posted.push(message);
    this.onPost?.(message);
  }

  on(event: 'message' | 'exit', listener: never): void {
    if (event === 'message') this.messageListeners.add(listener as (message: InterpreterToMain) => void);
    else this.exitListeners.add(listener as (code?: number) => void);
  }

  off(_event: 'message', listener: (message: InterpreterToMain) => void): void {
    this.messageListeners.delete(listener);
  }

  emit(message: InterpreterToMain): void {
    for (const listener of this.messageListeners) listener(message);
  }

  get createRequests(): Array<Extract<MainToInterpreter, { type: 'create-session' }>> {
    return this.posted.filter(
      (message): message is Extract<MainToInterpreter, { type: 'create-session' }> =>
        message.type === 'create-session',
    );
  }
}

class BlockingRemoveRunner extends GitRunner {
  removeCalls = 0;
  removeCompleted = false;
  blockRemove = false;
  private release: (() => void) | null = null;
  private readonly permission = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  constructor(private readonly events: string[]) {
    super();
  }

  allowRemove(): void {
    this.release?.();
  }

  override async run(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
    if (args[0] !== 'worktree' || args[1] !== 'remove') return super.run(cwd, args, signal);
    this.removeCalls += 1;
    this.events.push('remove:start');
    if (this.blockRemove) await this.permission;
    const result = await super.run(cwd, args, signal);
    this.removeCompleted = true;
    this.events.push('remove:end');
    return result;
  }
}

function makeBroker(
  gate: AsyncMutationGate,
  interpreter: FakeInterpreter,
  runGuard?: SessionWorktreeGuard,
): InterpreterBroker {
  let id = 0;
  return new InterpreterBroker({
    interpreter,
    mutationGate: gate,
    runGuard,
    validateSessionCwd: (cwd) => {
      try {
        return statSync(cwd).isDirectory();
      } catch {
        return false;
      }
    },
    newId: () => `request-${++id}`,
    createMessageChannel: () => {
      throw new Error('message channel is not used by these tests');
    },
  });
}

describe('session creation / worktree removal mutation gate', () => {
  it('blocks removal after an idle session changed cwd into the worktree', async () => {
    const { repo, userData } = makeRepo();
    const gate = new ObservedGate();
    const runGuard = new SessionWorktreeGuard();
    const interpreter = new FakeInterpreter();
    const broker = makeBroker(gate, interpreter, runGuard);
    const service = new WorktreeService({
      userDataDir: userData,
      newId: () => 'managed-worktree-cwd',
      mutationGate: gate,
      runGuard,
      getSessionCwds: () => broker.listSessions().map((session) => session.cwd),
    });
    const created = await service.execute(
      { action: 'create', cwd: repo, branch: 'cwd-update-wins' },
      'desktop',
    );
    if (!created.ok || !created.opened) throw new Error('worktree create failed');

    const session = broker.createSession(repo);
    const createRequest = interpreter.createRequests[0];
    expect(runGuard.tryBeginRun({ sessionId: 'session-after-cd', runId: 'run-cd' })).toBe(true);
    interpreter.emit({
      type: 'session-created',
      requestId: createRequest.requestId,
      sessionId: 'session-after-cd',
      cwd: repo,
    });
    await session;
    interpreter.emit({
      type: 'session-run-settled',
      sessionId: 'session-after-cd',
      runId: 'run-cd',
      cwd: created.opened.path,
    });
    expect(broker.listSessions()).toEqual([{
      sessionId: 'session-after-cd',
      cwd: created.opened.path,
    }]);

    const removal = await service.execute(
      { action: 'remove', cwd: repo, worktreeId: created.opened.worktreeId },
      'desktop',
    );
    expect(removal).toMatchObject({ ok: false, error: 'WORKTREE_IN_USE' });
    expect(existsSync(created.opened.path)).toBe(true);
  }, 30_000);

  it('create-first makes the completed session visible to remove before Git can delete', async () => {
    const { repo, userData } = makeRepo();
    const gate = new ObservedGate();
    const runner = new BlockingRemoveRunner([]);
    const interpreter = new FakeInterpreter();
    const broker = makeBroker(gate, interpreter);
    const service = new WorktreeService({
      userDataDir: userData,
      newId: () => 'managed-worktree-1',
      gitRunner: runner,
      mutationGate: gate,
      getSessionCwds: () => broker.listSessions().map((session) => session.cwd),
    });
    const created = await service.execute({ action: 'create', cwd: repo, branch: 'create-wins' }, 'desktop');
    if (!created.ok || !created.opened) throw new Error('worktree create failed');

    const session = broker.createSession(created.opened.path);
    expect(interpreter.createRequests).toHaveLength(1);
    const removal = service.execute(
      { action: 'remove', cwd: repo, worktreeId: created.opened.worktreeId },
      'desktop',
    );
    await vi.waitFor(() => expect(gate.callCount).toBe(2), { timeout: 15_000, interval: 25 });
    expect(runner.removeCalls).toBe(0);

    interpreter.emit({
      type: 'session-created',
      requestId: interpreter.createRequests[0].requestId,
      sessionId: 'session-in-worktree',
      cwd: created.opened.path,
    });
    await expect(session).resolves.toMatchObject({ sessionId: 'session-in-worktree' });
    await expect(removal).resolves.toMatchObject({ ok: false, error: 'WORKTREE_IN_USE' });
    expect(runner.removeCalls).toBe(0);
    expect(existsSync(created.opened.path)).toBe(true);
  }, 30_000);

  it('remove-first rejects createSession after git removed its requested cwd', async () => {
    const { repo, userData } = makeRepo();
    const events: string[] = [];
    const gate = new ObservedGate();
    const runGuard = new SessionWorktreeGuard();
    const runner = new BlockingRemoveRunner(events);
    runner.blockRemove = true;
    const interpreter = new FakeInterpreter((message) => {
      if (message.type === 'create-session') events.push('create:post');
    });
    const broker = makeBroker(gate, interpreter, runGuard);
    const service = new WorktreeService({
      userDataDir: userData,
      newId: () => 'managed-worktree-2',
      gitRunner: runner,
      mutationGate: gate,
      runGuard,
      getSessionCwds: () => broker.listSessions().map((session) => session.cwd),
    });
    const created = await service.execute({ action: 'create', cwd: repo, branch: 'remove-wins' }, 'desktop');
    if (!created.ok || !created.opened) throw new Error('worktree create failed');

    const removal = service.execute(
      { action: 'remove', cwd: repo, worktreeId: created.opened.worktreeId },
      'desktop',
    );
    await vi.waitFor(() => expect(runner.removeCalls).toBe(1), { timeout: 15_000, interval: 25 });
    expect(broker.runCommand(repo, 'run-during-remove', 'ls')).toBeNull();
    expect(interpreter.posted.some((message) => message.type === 'run')).toBe(false);
    const session = broker.createSession(created.opened.path);
    const sessionRejection = expect(session).rejects.toThrow(/no longer an existing directory/);
    expect(gate.callCount).toBe(2);
    expect(interpreter.createRequests).toHaveLength(0);

    runner.allowRemove();
    await expect(removal).resolves.toMatchObject({ ok: true, action: 'remove' });
    expect(runner.removeCompleted).toBe(true);
    await sessionRejection;
    expect(interpreter.createRequests).toHaveLength(0);
    expect(events).toEqual(['remove:start', 'remove:end']);
    expect(existsSync(created.opened.path)).toBe(false);
  }, 30_000);
});
