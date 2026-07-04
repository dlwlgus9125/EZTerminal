/**
 * Script-host utilityProcess entry (E4) — runs exactly ONE user script per
 * process lifetime (design §2: "run 1회 = host 1개"). Forked by MAIN (C1/C2 —
 * the interpreter cannot fork a utilityProcess itself), wired directly to the
 * interpreter over a dedicated MessagePortMain that main brokers but never
 * relays traffic on (see src/interpreter/script-runner.ts for the protocol
 * this speaks). Message shapes are declared locally rather than imported from
 * the interpreter — this is a separate Vite bundle with no business pulling in
 * the shell core, and the two ends are coupled by wire shape, not a shared type.
 *
 * Responsibilities:
 *   - patch process.stdout/stderr.write to ALSO forward text as `script-print`
 *     frames over the port (stdio stays 'inherit' — additive, gate §6 ⑤);
 *   - expose the `ez` global ({ run, args, cwd }) — `ez.run(cmd)` is a request/
 *     reply round-trip over the port; the interpreter runs it inline against
 *     the live session (the host has no shell state of its own);
 *   - dynamically `import()` the user's script (a real filesystem path,
 *     outside asar — bare imports therefore resolve from ITS directory tree,
 *     not the app's, documented in scripting-design.md §1) and resolve its
 *     default export;
 *   - report `script-done {rows?}` (rows = a JSON-cloneable array of plain
 *     objects; anything else is the text path — the runner already has the
 *     printed text, so stdout is not re-sent) or `script-error {message}`.
 *
 * Teardown is NOT this module's job: the interpreter kills the host once it
 * has settled (done/error/abort) — there is no cleanup guarantee for the
 * user's own code (design C4), so this file never tries to self-exit.
 */

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import type { MessagePortMain } from 'electron';

// Electron's MessagePortMain/parentPort event shape (mirrors the same local
// alias in interpreter-process.ts — the DOM MessageEvent type is structurally
// wider and does not match what Electron actually delivers here).
type ElectronMsgEvent = { data: unknown; ports: ReadonlyArray<unknown> };

interface InitMessage {
  readonly type: 'init';
  readonly hostId: string;
  readonly scriptPath: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

interface EzRunResultMsg {
  readonly type: 'ez-run-result';
  readonly id: string;
  readonly rows?: readonly PlainRow[];
  readonly error?: string;
}

type PlainRow = Record<string, unknown>;

/** An array of non-null, non-array objects, JSON-round-tripped; else undefined (text path). */
function toJsonCloneableRows(value: unknown): PlainRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as PlainRow[];
  } catch {
    return undefined; // circular refs / BigInt / etc. — fall back to the text path
  }
}

/** A few lines of stack (or the bare message) — enough context without a wall of text. */
function messageWithStackHead(err: unknown): string {
  if (err instanceof Error) {
    const head = (err.stack ?? '').split('\n').slice(0, 5).join('\n');
    return head || err.message;
  }
  return String(err);
}

process.parentPort.once('message', (event: ElectronMsgEvent) => {
  const init = event.data as InitMessage;
  const port = event.ports[0] as unknown as MessagePortMain;

  // Patch stdout/stderr to ALSO forward over the port; stdio stays inherited
  // so a dev console still shows the raw output (gate §6 resolution ⑤).
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      try {
        port.postMessage({ type: 'script-print', text });
      } catch {
        // Port already gone — nothing to forward to.
      }
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as unknown as typeof stream.write;
  }

  const pendingEzRuns = new Map<
    string,
    { resolve: (rows: readonly PlainRow[]) => void; reject: (err: Error) => void }
  >();
  port.on('message', (e: ElectronMsgEvent) => {
    const msg = e.data as EzRunResultMsg;
    if (msg?.type !== 'ez-run-result') return;
    const pending = pendingEzRuns.get(msg.id);
    if (!pending) return;
    pendingEzRuns.delete(msg.id);
    if (msg.error !== undefined) pending.reject(new Error(msg.error));
    else pending.resolve(msg.rows ?? []);
  });
  port.start();

  const ez = {
    args: init.args,
    cwd: init.cwd,
    run(command: string): Promise<{ rows: PlainRow[] }> {
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        pendingEzRuns.set(id, { resolve: (rows) => resolve({ rows: [...rows] }), reject });
        port.postMessage({ type: 'ez-run', id, command });
      });
    },
  };
  (globalThis as unknown as { ez: typeof ez }).ez = ez;

  async function run(): Promise<void> {
    const mod = (await import(pathToFileURL(init.scriptPath).href)) as { default?: unknown };
    let value: unknown = mod.default;
    value = typeof value === 'function' ? await (value as () => unknown)() : await value;

    const rows = toJsonCloneableRows(value);
    port.postMessage({ type: 'script-done', rows });
  }

  run().catch((err: unknown) => {
    try {
      port.postMessage({ type: 'script-error', message: messageWithStackHead(err) });
    } catch {
      // Port already gone — the interpreter will notice via port-close anyway.
    }
  });
});
