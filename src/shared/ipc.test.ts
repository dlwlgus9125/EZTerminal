import { describe, it, expect } from 'vitest';
import type {
  InterpreterFrame,
  InterpreterToMain,
  MainToInterpreter,
  RendererControl,
  ResultShape,
} from './ipc';
import { isRecentPanelInputEvent } from './ipc';

describe('recent panel desktop input event', () => {
  it('accepts only the narrow cycle/commit/cancel union', () => {
    expect(isRecentPanelInputEvent({ type: 'cycle', reverse: true })).toBe(true);
    expect(isRecentPanelInputEvent({ type: 'commit' })).toBe(true);
    expect(isRecentPanelInputEvent({ type: 'cancel', restoreFocus: false })).toBe(true);
    expect(isRecentPanelInputEvent({ type: 'cycle', reverse: 'yes' })).toBe(false);
    expect(isRecentPanelInputEvent({ type: 'cancel' })).toBe(false);
    expect(isRecentPanelInputEvent({ type: 'commit', command: 'hidden payload' })).toBe(false);
    expect(isRecentPanelInputEvent({ type: 'run', command: 'rm -rf' })).toBe(false);
  });
});

// M2: the PTY protocol additions are type-level contracts; these assert they
// narrow correctly (compile-time via the type annotations + runtime discriminant).
describe('IPC PTY protocol (Phase 2, additive)', () => {
  it('pty-data is a member of InterpreterFrame and carries Uint8Array', () => {
    const frame: InterpreterFrame = { type: 'pty-data', data: new Uint8Array([27, 91, 50, 74]) };
    expect(frame.type).toBe('pty-data');
    if (frame.type === 'pty-data') {
      const bytes: Uint8Array = frame.data;
      expect(bytes.length).toBe(4);
    }
  });

  it('marks historical pty-data as render-only without changing live frames', () => {
    const live: InterpreterFrame = { type: 'pty-data', data: new Uint8Array([1]) };
    const replay: InterpreterFrame = {
      type: 'pty-data',
      data: new Uint8Array([2]),
      suppressSideEffects: true,
    };
    expect(live).not.toHaveProperty('suppressSideEffects');
    expect(replay).toMatchObject({ suppressSideEffects: true });
  });

  it('pty-input and pty-resize are members of RendererControl', () => {
    const input: RendererControl = { type: 'pty-input', data: 'ls\r' };
    const resize: RendererControl = { type: 'pty-resize', cols: 120, rows: 30 };

    expect(input.type).toBe('pty-input');
    if (input.type === 'pty-input') {
      expect(input.data).toBe('ls\r');
    }
    if (resize.type === 'pty-resize') {
      expect(resize.cols).toBe(120);
      expect(resize.rows).toBe(30);
    }
  });

  it("ResultShape includes 'pty' alongside table/text", () => {
    const shapes: ResultShape[] = ['table', 'text', 'pty'];
    expect(shapes).toContain('pty');
  });
});

// E5: ssh-connect protocol additions — same compile-time-narrows-correctly contract.
describe('IPC ssh-connect protocol (E5, additive)', () => {
  it('ssh-prompt is a member of InterpreterFrame for each prompt kind', () => {
    const password: InterpreterFrame = {
      type: 'ssh-prompt',
      promptId: 'p1',
      kind: 'password',
      message: 'Password for a@b:',
    };
    const hostkey: InterpreterFrame = {
      type: 'ssh-prompt',
      promptId: 'p2',
      kind: 'hostkey',
      message: "The authenticity of host 'a:22' can't be established.",
      fingerprint: 'SHA256:abc',
      host: 'a',
    };
    expect(password.type).toBe('ssh-prompt');
    expect(hostkey.type).toBe('ssh-prompt');
    if (hostkey.type === 'ssh-prompt') {
      expect(hostkey.fingerprint).toBe('SHA256:abc');
      expect(hostkey.host).toBe('a');
    }
  });

  it('ssh-prompt-response is a member of RendererControl (value or accept)', () => {
    const passwordAnswer: RendererControl = { type: 'ssh-prompt-response', promptId: 'p1', value: 'hunter2' };
    const hostkeyAnswer: RendererControl = { type: 'ssh-prompt-response', promptId: 'p2', accept: true };
    expect(passwordAnswer.type).toBe('ssh-prompt-response');
    if (passwordAnswer.type === 'ssh-prompt-response') expect(passwordAnswer.value).toBe('hunter2');
    if (hostkeyAnswer.type === 'ssh-prompt-response') expect(hostkeyAnswer.accept).toBe(true);
  });

  it('known-host-check/add are members of InterpreterToMain', () => {
    const check: InterpreterToMain = {
      type: 'known-host-check',
      requestId: 'r1',
      host: 'example.com',
      port: 22,
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:abc',
    };
    const add: InterpreterToMain = {
      type: 'known-host-add',
      host: 'example.com',
      port: 22,
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:abc',
    };
    expect(check.type).toBe('known-host-check');
    expect(add.type).toBe('known-host-add');
  });

  it('known-host-verdict is a member of MainToInterpreter and always carries knownHostsPath', () => {
    const verdict: MainToInterpreter = {
      type: 'known-host-verdict',
      requestId: 'r1',
      verdict: 'mismatch',
      existingFingerprint: 'SHA256:old',
      knownHostsPath: 'C:/userdata/known_hosts.json',
    };
    expect(verdict.type).toBe('known-host-verdict');
    if (verdict.type === 'known-host-verdict') {
      expect(verdict.knownHostsPath).toBe('C:/userdata/known_hosts.json');
    }
  });
});
