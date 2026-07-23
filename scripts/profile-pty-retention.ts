import { performance } from 'node:perf_hooks';

import { JSDOM } from 'jsdom';

import {
  BatchedPlainOutputDomRetention,
  PTY_PLAIN_HISTORY_MAX_BYTES,
  PtyReplayBuffer,
} from '../src/renderer/pty-output-retention';
import { SCROLLBACK_DEFAULT } from '../src/renderer/scrollback';

const lineCount = Number.parseInt(process.argv[2] ?? '12000', 10);
const lineBytes = Number.parseInt(process.argv[3] ?? '1001', 10);
if (!Number.isSafeInteger(lineCount) || lineCount <= 0) {
  throw new Error('line count must be a positive safe integer');
}
if (!Number.isSafeInteger(lineBytes) || lineBytes < 2) {
  throw new Error('line bytes must be an integer of at least two');
}

const line = new Uint8Array(lineBytes);
line.fill(0x72);
line[line.length - 1] = 0x0a;
const retention = new PtyReplayBuffer();
const startedAt = performance.now();
const checkpoints: Array<{ readonly lines: number; readonly elapsedMs: number }> = [];

for (let index = 0; index < lineCount; index += 1) {
  retention.append(
    { bytes: line.slice(), suppressSideEffects: false, alreadyConsumed: true },
    { maxLines: SCROLLBACK_DEFAULT, maxBytes: PTY_PLAIN_HISTORY_MAX_BYTES },
  );
  if ((index + 1) % 1_000 === 0) {
    checkpoints.push({
      lines: index + 1,
      elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });
  }
}

const rawElapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
const dom = new JSDOM('<pre id="output"></pre>');
const output = dom.window.document.querySelector('#output') as unknown as HTMLElement;
const domRetention = new BatchedPlainOutputDomRetention(() => () => {});
const textLine = `${'r'.repeat(lineBytes - 1)}\n`;
const outputText = textLine.repeat(lineCount);
const domStartedAt = performance.now();
for (let offset = 0; offset < outputText.length; offset += 64 * 1024) {
  domRetention.append(
    output,
    outputText.slice(offset, offset + (64 * 1024)),
    SCROLLBACK_DEFAULT,
  );
}
domRetention.flush();
const domElapsedMs = Math.round((performance.now() - domStartedAt) * 100) / 100;

process.stdout.write(`${JSON.stringify({
  lineCount,
  lineBytes,
  rawReplay: {
    elapsedMs: rawElapsedMs,
    retained: retention.diagnostics(),
    work: retention.workDiagnostics(),
    checkpoints,
  },
  dom: {
    elapsedMs: domElapsedMs,
    retained: domRetention.diagnostics(),
    childNodes: output.childNodes.length,
  },
})}\n`);
