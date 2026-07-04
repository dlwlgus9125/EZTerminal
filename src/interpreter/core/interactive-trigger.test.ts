import { describe, it, expect } from 'vitest';

import type { Command } from './ast';
import { ParseError, EvalError } from './errors';
import { evaluate } from './index';
import { parse } from './parser';
import type { EvalContext } from './types';
import { emptyListStream, type PipelineData } from './value';

describe('`!` force-xterm trigger — parser', () => {
  it('parses `!vim` as a single-command forceXterm pipeline', () => {
    const stmt = parse('!vim');
    expect(stmt.type).toBe('pipeline');
    if (stmt.type === 'pipeline') {
      expect(stmt.forceXterm).toBe(true);
      expect(stmt.commands).toHaveLength(1);
      expect(stmt.commands[0].name).toBe('vim');
    }
  });

  it('keeps args after the sigil (`!vim notes.txt`)', () => {
    const stmt = parse('!vim notes.txt');
    expect(stmt.type).toBe('pipeline');
    if (stmt.type === 'pipeline') {
      expect(stmt.forceXterm).toBe(true);
      expect(stmt.commands[0].name).toBe('vim');
      expect(stmt.commands[0].args).toHaveLength(1);
    }
  });

  it('rejects `!` on a pipeline (`!a | b`)', () => {
    expect(() => parse('!a | b')).toThrow(ParseError);
  });

  it('a bare command does not force xterm', () => {
    const stmt = parse('vim');
    if (stmt.type === 'pipeline') {
      expect(stmt.forceXterm).toBeFalsy();
    }
  });

  it('a normal pipeline does not force xterm', () => {
    const stmt = parse('ls | where size > 100mb');
    if (stmt.type === 'pipeline') {
      expect(stmt.forceXterm).toBeFalsy();
      expect(stmt.commands).toHaveLength(2);
    }
  });
});

describe('`!` force-xterm trigger — evaluator', () => {
  function makeCtx(
    onExternal?: (
      command: Command,
      opts?: { interactive?: boolean; forceXterm?: boolean },
    ) => PipelineData,
  ): EvalContext {
    return {
      cwd: process.cwd(),
      env: process.env,
      signal: new AbortController().signal,
      session: {} as EvalContext['session'],
      resolveExternal: onExternal
        ? (command, _ctx, opts) => onExternal(command, opts)
        : undefined,
    };
  }

  it('passes interactive:true and forceXterm:true to resolveExternal for `!extcmd`', () => {
    let seen: { interactive?: boolean; forceXterm?: boolean } | undefined;
    const ctx = makeCtx((_cmd, opts) => {
      seen = opts;
      return emptyListStream();
    });
    evaluate(parse('!my-external-tool'), ctx);
    expect(seen?.interactive).toBe(true);
    expect(seen?.forceXterm).toBe(true);
  });

  it('(M2 auto PTY routing) a bare single-stage external command is interactive by default, without forceXterm', () => {
    let seen: { interactive?: boolean; forceXterm?: boolean } | undefined;
    const ctx = makeCtx((_cmd, opts) => {
      seen = opts;
      return emptyListStream();
    });
    evaluate(parse('my-external-tool'), ctx);
    expect(seen?.interactive).toBe(true);
    expect(seen?.forceXterm).toBeFalsy();
  });

  it('a multi-stage pipeline keeps its external stage non-interactive (text capture, M4 stdin policy)', () => {
    let seen: { interactive?: boolean; forceXterm?: boolean } | undefined;
    const ctx = makeCtx((_cmd, opts) => {
      seen = opts;
      return emptyListStream();
    });
    evaluate(parse('my-external-tool | where n > 1'), ctx);
    expect(seen?.interactive).toBeFalsy();
  });

  it('(B1) rejects `!` on a builtin (`!ls`) with an EvalError', () => {
    const ctx = makeCtx(() => emptyListStream());
    expect(() => evaluate(parse('!ls'), ctx)).toThrow(EvalError);
    expect(() => evaluate(parse('!ls'), ctx)).toThrow(/builtin/i);
  });
});
