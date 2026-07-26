import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';

import { packagedExePath } from './paths';

// The packaged-only delta is native module placement/loading. Functional
// pause/resume and renderer backpressure remain in the ordinary E2E suite.
const require = createRequire(__filename);

function unpackedNodePtyDir(): string {
  return path.join(
    path.dirname(packagedExePath()),
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
  );
}

test('packaged node-pty: loads from app.asar.unpacked and spawns a working PTY', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pty = require(unpackedNodePtyDir()) as typeof import('node-pty');
  const marker = `PKG_PTY_OK_${process.pid}`;
  const proc = pty.spawn(
    process.execPath,
    ['-e', `process.stdout.write(${JSON.stringify(marker)})`],
    {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    },
  );

  const output = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(
      () => reject(new Error(`packaged PTY spawn timed out; got: ${JSON.stringify(buffer)}`)),
      15_000,
    );
    proc.onData((data) => {
      buffer += data;
    });
    proc.onExit(() => {
      clearTimeout(timer);
      resolve(buffer);
    });
  });

  expect(output).toContain(marker);
});
