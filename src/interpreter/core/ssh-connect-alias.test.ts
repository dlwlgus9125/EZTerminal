import { describe, expect, it } from 'vitest';

import { evaluate, parse } from './index';
import { ShellSession } from '../shell-session';

function evaluateSsh(command: string) {
  const context = new ShellSession(process.cwd()).createContext(new AbortController().signal);
  return evaluate(parse(command), context);
}

describe('ssh-connect target parsing', () => {
  it('preserves the legacy direct user@host marker and defaults', () => {
    expect(evaluateSsh('ssh-connect alice@example.com')).toEqual({
      kind: 'ssh-stream',
      host: 'example.com',
      port: 22,
      user: 'alice',
      keyPath: undefined,
    });
  });

  it('emits an unresolved alias marker with explicit overrides', () => {
    expect(evaluateSsh('ssh-connect production --port 2202 --key "C:/keys/prod key"')).toEqual({
      kind: 'ssh-stream',
      targetKind: 'alias',
      alias: 'production',
      portOverride: 2202,
      keyPathOverride: 'C:/keys/prod key',
    });
  });

  it('keeps explicit direct overrides compatible', () => {
    expect(evaluateSsh('ssh-connect alice@example.com --port 2202 --key "id_ed25519"')).toMatchObject({
      host: 'example.com',
      port: 2202,
      user: 'alice',
      keyPath: 'id_ed25519',
    });
  });
});
