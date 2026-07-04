/**
 * M1 — SessionRegistry: the interpreter's multi-session backend for Track A.
 * Proves the Codex-gated invariants: sessions are created only via create (never
 * lazily on run, B1), destroy owns in-flight executions (B2), foreground runs are
 * serialized within a session (B4), and sessions are isolated (own cwd/env/vars/history).
 */

import { describe, it, expect, vi } from 'vitest';

import { evaluate, parse } from './core';
import type { EvalContext } from './core';
import type { ShellSession } from './shell-session';
import { SessionRegistry, type Execution } from './session-registry';

/** Deterministic id generator (production uses crypto.randomUUID). */
function ids(): () => string {
  let n = 0;
  return () => `s${++n}`;
}

function ctxOf(shell: ShellSession): EvalContext {
  return shell.createContext(new AbortController().signal);
}

/** A fake execution the registry can track + tear down without real ports. */
function fakeExecution(): Execution & { abort: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } {
  return { abort: vi.fn(), dispose: vi.fn() };
}

describe('SessionRegistry — create / get', () => {
  it('mints a fresh session id and its authoritative cwd (B5)', () => {
    const reg = new SessionRegistry(ids(), () => 'C:\\start');
    const a = reg.create();
    expect(a).toEqual({ sessionId: 's1', cwd: 'C:\\start' });
    expect(reg.size).toBe(1);

    const b = reg.create('C:\\other');
    expect(b).toEqual({ sessionId: 's2', cwd: 'C:\\other' });
    expect(reg.size).toBe(2);
  });

  it('get returns the record for a live session, undefined otherwise', () => {
    const reg = new SessionRegistry(ids(), () => 'C:\\start');
    const { sessionId } = reg.create();
    expect(reg.get(sessionId)?.state).toBe('live');
    expect(reg.get('missing')).toBeUndefined();
  });
});

describe('SessionRegistry — isolation (independent cwd / env / variables / history)', () => {
  it('state set in one session does not leak into another', () => {
    const reg = new SessionRegistry(ids(), () => 'C:\\start');
    const a = reg.create('C:\\start');
    const b = reg.create('C:\\start');
    const shellA = reg.get(a.sessionId)!.shell;
    const shellB = reg.get(b.sessionId)!.shell;

    // Mutate session A only, through the real evaluator.
    evaluate(parse('let x = 5'), ctxOf(shellA));
    evaluate(parse('$env.GREETING = "hi"'), ctxOf(shellA));
    shellA.addHistory('let x = 5');

    // Session A sees its own state.
    expect(shellA.getVar('x')).toEqual({ kind: 'number', value: 5 });
    expect(shellA.env.GREETING).toBe('hi');
    expect(shellA.getHistory()).toEqual(['let x = 5']);

    // Session B is untouched.
    expect(shellB.getVar('x')).toBeUndefined();
    expect(shellB.env.GREETING).toBeUndefined();
    expect(shellB.getHistory()).toEqual([]);
    expect(shellB.cwd).toBe('C:\\start');
  });
});

describe('SessionRegistry — canRun gating (B1 no lazy-create, B4 serialize)', () => {
  it('rejects a run for an unknown session WITHOUT creating one (B1)', () => {
    const reg = new SessionRegistry(ids(), () => 'C:\\start');
    const gate = reg.canRun('nope');
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/does not exist/);
    expect(reg.size).toBe(0); // the rejected run did not resurrect/create a session
  });

  it('rejects a run for a destroyed session (no zombie resurrection, B1)', () => {
    const reg = new SessionRegistry(ids(), () => 'C:\\start');
    const { sessionId } = reg.create();
    expect(reg.canRun(sessionId).ok).toBe(true);
    reg.destroy(sessionId);
    const gate = reg.canRun(sessionId);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/does not exist/);
  });

  it('serializes foreground runs within a session (B4)', () => {
    const reg = new SessionRegistry(ids(), () => 'C:\\start');
    const { sessionId } = reg.create();
    const record = reg.get(sessionId)!;
    const exec = fakeExecution();

    reg.begin(record, exec);
    const busy = reg.canRun(sessionId);
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.reason).toMatch(/already running/);

    // The terminal frame frees the foreground slot but keeps the exec tracked for
    // teardown (its port stays open for paging).
    reg.settle(record, exec);
    expect(reg.canRun(sessionId).ok).toBe(true);
    expect(record.executions.has(exec)).toBe(true);

    // Disposal (port closed) drops it from teardown tracking.
    reg.remove(record, exec);
    expect(record.executions.has(exec)).toBe(false);
  });
});

describe('SessionRegistry — destroy owns in-flight executions (B2/B6)', () => {
  it('aborts + disposes every open execution, then drops the session; idempotent', () => {
    const reg = new SessionRegistry(ids(), () => 'C:\\start');
    const { sessionId } = reg.create();
    const record = reg.get(sessionId)!;
    const running = fakeExecution();
    const paging = fakeExecution();
    reg.begin(record, running);
    reg.settle(record, running); // running finished, still paging
    reg.begin(record, paging);

    reg.destroy(sessionId);

    for (const exec of [running, paging]) {
      expect(exec.abort).toHaveBeenCalledOnce();
      expect(exec.dispose).toHaveBeenCalledOnce();
    }
    expect(reg.get(sessionId)).toBeUndefined();
    expect(reg.size).toBe(0);

    // Idempotent: destroying again is a no-op (does not throw).
    expect(() => reg.destroy(sessionId)).not.toThrow();
  });
});
