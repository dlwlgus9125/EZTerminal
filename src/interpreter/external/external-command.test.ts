import { describe, expect, it } from 'vitest';

import { evaluate, parse } from '../core';
import type { EvalContext, PipelineData } from '../core';
import { commandToArgv, createExternalResolver } from './external-command';
import { ShellSession } from '../shell-session';

function commandOf(text: string) {
  const stmt = parse(text);
  if (stmt.type !== 'pipeline') throw new Error(`expected a pipeline, got ${stmt.type}`);
  return stmt.commands[0];
}

function ctx(signal?: AbortSignal): EvalContext {
  return new ShellSession(process.cwd()).createContext(
    signal ?? new AbortController().signal,
    createExternalResolver(),
  );
}

async function collectText(data: PipelineData): Promise<string> {
  if (data.kind !== 'byte-stream') throw new Error(`expected byte-stream, got ${data.kind}`);
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of data.bytes) out += decoder.decode(chunk, { stream: true });
  out += decoder.decode();
  return out;
}

describe('commandToArgv', () => {
  it('reconstructs a long flag with no value (node --version)', () => {
    expect(commandToArgv(commandOf('node --version'))).toEqual(['--version']);
  });

  it('reconstructs a bare positional (git status)', () => {
    expect(commandToArgv(commandOf('git status'))).toEqual(['status']);
  });

  it('reconstructs a short flag with a quoted string value (node -e "…")', () => {
    expect(commandToArgv(commandOf('node -e "setInterval(() => {}, 100)"'))).toEqual([
      '-e',
      'setInterval(() => {}, 100)',
    ]);
  });

  it('reconstructs a long flag with a value', () => {
    expect(commandToArgv(commandOf('tool --name value'))).toEqual(['--name', 'value']);
  });
});

describe('external dispatch via evaluate', () => {
  // M2: a bare, single-stage external command is interactive by default (auto PTY
  // routing) — it now dispatches to a real PTY spawn, not the byte-stream text
  // path. See external-command-pty.test.ts for the resolver-level unit coverage
  // with an injected fake spawn (this test proves the real evaluate()→resolver→
  // node-pty round trip, mirroring node-pty-native.test.ts's pattern).
  it('(M2 auto PTY routing) a bare non-builtin → pty-stream, spawns for real and produces the version', async () => {
    // `node` is always on PATH in the test environment.
    const data = evaluate(parse('node --version'), ctx());
    expect(data.kind).toBe('pty-stream');
    if (data.kind !== 'pty-stream') return;
    const handle = data.spawn(80, 24);
    const output = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(
        () => reject(new Error(`pty spawn timed out; got: ${JSON.stringify(buf)}`)),
        10_000,
      );
      handle.onData((bytes) => {
        buf += new TextDecoder().decode(bytes);
      });
      handle.onExit(() => {
        clearTimeout(timer);
        resolve(buf);
      });
    });
    expect(output).toMatch(/v?\d+\.\d+\.\d+/);
  }, 15_000);

  // M2: a bare unresolvable command now resolves EAGERLY (the interactive path
  // resolves synchronously before returning), unlike the lazy byte-stream path.
  it('(M2 auto PTY routing) a bare unresolvable command fails eagerly at evaluate()', () => {
    expect(() => evaluate(parse('definitely-not-a-real-cmd-xyz'), ctx())).toThrow(
      /command not found/,
    );
  });

  // The byte-stream text-capture path (exit-code trailing line, lazy resolution)
  // is still exactly what a multi-stage pipeline's external stage gets (M4's
  // non-interactive policy) — exercised directly via {interactive:false}, the
  // same opts evaluatePipeline passes for a piped external command.
  it('(M4 pipe policy) a non-interactive external stage surfaces a non-zero exit code as a trailing line', async () => {
    const resolve = createExternalResolver();
    const data = resolve(
      commandOf('node -e "process.stdout.write(\'partial\'); process.exit(2)"'),
      ctx(),
      { interactive: false },
    );
    const text = await collectText(data);
    expect(text).toContain('partial');
    expect(text).toContain('process exited with code 2');
  });

  it('(M4 pipe policy) reports an unresolvable command as "command not found" when iterated (lazy)', async () => {
    const resolve = createExternalResolver();
    const data = resolve(commandOf('definitely-not-a-real-cmd-xyz'), ctx(), { interactive: false });
    expect(data.kind).toBe('byte-stream'); // dispatched to external, lazily
    await expect(collectText(data)).rejects.toThrow(/command not found/);
  });

  it('still throws "unknown command" when no external resolver is wired', () => {
    const bare: EvalContext = new ShellSession(process.cwd()).createContext(
      new AbortController().signal,
    );
    expect(() => evaluate(parse('definitely-not-a-real-cmd-xyz'), bare)).toThrow(/unknown command/);
  });
});
