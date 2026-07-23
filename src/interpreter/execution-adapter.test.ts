import { describe, expect, it, vi } from 'vitest';

import type { RendererControl } from '../shared/ipc';
import type { BlockHandle } from './block-runner';
import {
  listStreamData,
  ptyStreamData,
  recordValue,
  scriptStreamData,
  sshForwardCommandData,
  sshStreamData,
  type PipelineData,
} from './core';
import {
  disposeExecutionAdapterWithRetry,
  startExecutionAdapter,
  type ActiveExecutionAdapter,
  type ExecutionAdapterStarters,
} from './execution-adapter';
import type { PtyAttachHandle, PtySession } from './pty-session';
import type { ScriptSession } from './script-runner';
import type { SshForwardCommandSession } from './ssh-forward-command';
import type { SshSession } from './ssh-session';

interface Fakes {
  readonly starters: ExecutionAdapterStarters;
  readonly structured: BlockHandle;
  readonly pty: PtySession;
  readonly script: ScriptSession;
  readonly ssh: SshSession;
  readonly forward: SshForwardCommandSession;
  readonly ptyAttach: PtyAttachHandle;
}

function fakes(): Fakes {
  const ptyAttach = {
    replay: new Uint8Array([1, 2, 3]),
    releaseLive: vi.fn(() => null),
    ack: vi.fn(),
    detach: vi.fn(),
  } satisfies PtyAttachHandle;
  const structured = {
    handleControl: vi.fn(),
    dispose: vi.fn(() => Promise.resolve()),
    done: Promise.resolve(),
  } satisfies BlockHandle;
  const pty = {
    write: vi.fn(),
    resize: vi.fn(),
    ack: vi.fn(),
    attach: vi.fn(() => ptyAttach),
    dispose: vi.fn(),
  } satisfies PtySession;
  const script = {
    handleControl: vi.fn(),
    dispose: vi.fn(),
  } satisfies ScriptSession;
  const ssh = {
    connectionId: 'ssh-1',
    ready: true,
    handlePromptResponse: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    ack: vi.fn(),
    openForward: vi.fn(),
    dispose: vi.fn(),
  } as unknown as SshSession;
  const forward = {
    handleControl: vi.fn(),
    dispose: vi.fn(),
  } satisfies SshForwardCommandSession;
  return {
    structured,
    pty,
    script,
    ssh,
    forward,
    ptyAttach,
    starters: {
      startStructured: vi.fn(() => structured),
      startPty: vi.fn(() => pty),
      startScript: vi.fn(() => script),
      startSsh: vi.fn(() => ssh),
      startForward: vi.fn(() => forward),
    },
  };
}

const dataByKind = {
  structured: listStreamData((async function* () {
    yield recordValue({});
  })()),
  pty: ptyStreamData(() => {
    throw new Error('fake starter must hide the concrete spawn');
  }),
  script: scriptStreamData('C:/scripts/fake.js', []),
  ssh: sshStreamData('example.com', 22, 'alice'),
  forward: sshForwardCommandData({ action: 'list', connectionId: 'ssh-1' }),
} satisfies Record<'structured' | 'pty' | 'script' | 'ssh' | 'forward', PipelineData>;

function start(
  kind: keyof typeof dataByKind,
  values: Fakes,
): ActiveExecutionAdapter {
  return startExecutionAdapter(dataByKind[kind], values.starters);
}

describe('execution adapter contract', () => {
  it.each([
    ['structured', 'startStructured'],
    ['pty', 'startPty'],
    ['script', 'startScript'],
    ['ssh', 'startSsh'],
    ['forward', 'startForward'],
  ] as const)('starts exactly one %s adapter', (kind, starter) => {
    const values = fakes();
    const adapter = start(kind, values);

    expect(adapter.kind).toBe(kind);
    expect(values.starters[starter]).toHaveBeenCalledOnce();
    const startCalls = Object.values(values.starters)
      .reduce((total, candidate) => total + vi.mocked(candidate).mock.calls.length, 0);
    expect(startCalls).toBe(1);
  });

  it('routes structured, script, and forward paging controls only', () => {
    const values = fakes();
    const paging = { type: 'requestRows', start: 4, count: 8 } as const;
    const unsupported = { type: 'pty-input', data: 'x' } as const;

    for (const [kind, handle] of [
      ['structured', values.structured],
      ['script', values.script],
      ['forward', values.forward],
    ] as const) {
      const adapter = start(kind, values);
      expect(adapter.handleControl(paging)).toBe('handled');
      expect(handle.handleControl).toHaveBeenCalledWith(paging);
      expect(adapter.handleControl(unsupported)).toBe('unsupported');
    }
  });

  it('routes PTY controls and exposes its replay attach capability', () => {
    const values = fakes();
    const adapter = start('pty', values);
    const onData = vi.fn();

    expect(adapter.handleControl({ type: 'pty-input', data: 'hello' })).toBe('handled');
    expect(adapter.handleControl({ type: 'pty-resize', cols: 120, rows: 40 })).toBe('handled');
    expect(adapter.handleControl({ type: 'pty-ack', bytes: 65_536 })).toBe('handled');
    expect(values.pty.write).toHaveBeenCalledWith('hello');
    expect(values.pty.resize).toHaveBeenCalledWith(120, 40);
    expect(values.pty.ack).toHaveBeenCalledWith(65_536);
    expect(adapter.lateAttach.mode).toBe('pty-replay');
    if (adapter.lateAttach.mode !== 'pty-replay') throw new Error('wrong late-attach mode');
    expect(adapter.lateAttach.attach(onData)).toBe(values.ptyAttach);
    expect(values.pty.attach).toHaveBeenCalledWith(onData);
  });

  it('routes SSH terminal/prompt controls and rejects late attach by capability', () => {
    const values = fakes();
    const adapter = start('ssh', values);
    const prompt = {
      type: 'ssh-prompt-response',
      promptId: 'prompt-1',
      value: 'secret',
    } as const;

    expect(adapter.handleControl({ type: 'pty-input', data: 'x' })).toBe('handled');
    expect(adapter.handleControl({ type: 'pty-resize', cols: 90, rows: 30 })).toBe('handled');
    expect(adapter.handleControl({ type: 'pty-ack', bytes: 10 })).toBe('handled');
    expect(adapter.handleControl(prompt)).toBe('handled');
    expect(values.ssh.handlePromptResponse).toHaveBeenCalledWith(prompt);
    expect(adapter.lateAttach).toEqual({ mode: 'unsupported', reason: 'ssh-unsupported' });
  });

  it.each([
    { type: 'cancel' },
    { type: 'close' },
    { type: 'pty-claim-control' },
  ] satisfies RendererControl[])(
    'leaves lifecycle control $type to ExecutionSession',
    (control) => {
      for (const kind of Object.keys(dataByKind) as Array<keyof typeof dataByKind>) {
        expect(start(kind, fakes()).handleControl(control)).toBe('unsupported');
      }
    },
  );

  it.each([
    ['structured', 'structured'],
    ['pty', 'pty'],
    ['script', 'script'],
    ['ssh', 'ssh'],
    ['forward', 'forward'],
  ] as const)('disposes the %s runner exactly once', (kind, handleName) => {
    const values = fakes();
    const adapter = start(kind, values);

    adapter.dispose();
    adapter.dispose();

    expect(values[handleName].dispose).toHaveBeenCalledOnce();
    expect(adapter.handleControl({ type: 'requestRows', start: 0, count: 1 })).toBe('unsupported');
  });

  it('allows a closed adapter to retry a rejected physical cleanup', async () => {
    const values = fakes();
    vi.mocked(values.structured.dispose)
      .mockRejectedValueOnce(new Error('sharing violation'))
      .mockResolvedValueOnce();
    const adapter = start('structured', values);

    await expect(adapter.dispose()).rejects.toThrow('sharing violation');
    await adapter.dispose();

    expect(values.structured.dispose).toHaveBeenCalledTimes(2);
    expect(adapter.handleControl({ type: 'requestRows', start: 0, count: 1 })).toBe('unsupported');
  });

  it('retains detached cleanup ownership until a later bounded retry succeeds', async () => {
    const values = fakes();
    vi.mocked(values.structured.dispose)
      .mockRejectedValueOnce(new Error('sharing violation 1'))
      .mockRejectedValueOnce(new Error('sharing violation 2'))
      .mockRejectedValueOnce(new Error('sharing violation 3'))
      .mockResolvedValueOnce();
    const adapter = start('structured', values);

    await disposeExecutionAdapterWithRetry(adapter, [0, 0, 0]);

    expect(values.structured.dispose).toHaveBeenCalledTimes(4);
  });
});
