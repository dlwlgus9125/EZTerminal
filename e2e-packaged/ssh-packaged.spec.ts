import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';

import { packagedExePath } from './paths';

// ── E5 SSH: packaged pure-JS-module proof (gate B4) ─────────────────────────
//
// ssh2 is pure-JS (Option B packaging, design §7.3 — its optional native
// `cpu-features` accelerator is never built), but forge.config.ts unpacks it
// (and its prod-dependency closure: asn1, bcrypt-pbkdf, tweetnacl, safer-buffer)
// from app.asar anyway, for the SAME reason node-pty is unpacked in
// pty-packaged.spec.ts: this test needs to `require()` it from a PLAIN Node
// process (Playwright's test runner), which cannot read files packed inside an
// asar archive — only Electron's patched fs can do that. Driving `ssh-connect`
// through the fused EXE's UI is impossible here for the identical reason
// pty-packaged.spec.ts documents (the Node inspector fuse is off, so
// `electron.launch` against the real binary hangs); the interpreter-fork-from-
// asar fact is covered by packaged-smoke.spec.ts and the live renderer
// round-trip by e2e/ssh.spec.ts.
//
// This proves the packaged bits actually WORK (not just that they exist): a
// real localhost ssh2 `Server` + the packaged `Client` complete a full
// handshake (TOFU accept + password auth) and round-trip a shell session,
// exercising `setWindow` and the `close` teardown path — the same runtime
// surface `ssh-session.ts`'s adapter (external/ssh-client.ts) drives.

const require = createRequire(__filename);

function unpackedModuleDir(name: string): string {
  return path.join(path.dirname(packagedExePath()), 'resources', 'app.asar.unpacked', 'node_modules', name);
}

test('packaged ssh2: loads from app.asar.unpacked and round-trips a real localhost shell session', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ssh2 = require(unpackedModuleDir('ssh2')) as typeof import('ssh2');
  const { Client, Server, utils } = ssh2;
  type ServerChannel = import('ssh2').ServerChannel;
  type ClientChannel = import('ssh2').ClientChannel;
  type Connection = import('ssh2').Connection;

  const hostKey = utils.generateKeyPairSync('ed25519', {}).private;
  const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('pty', (acceptPty) => acceptPty());
        session.on('shell', (acceptShell) => {
          const channel: ServerChannel = acceptShell();
          channel.write('READY\r\n');
          channel.on('data', (data: Buffer) => {
            channel.write(`ECHO:${data.toString('utf8')}`);
          });
        });
      });
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('server failed to bind to a port'));
    });
  });

  try {
    const client = new Client();
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      client.on('error', reject);
      client.on('ready', () => {
        client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, ch) => {
          if (err || !ch) reject(err ?? new Error('shell() returned no channel'));
          else resolve(ch);
        });
      });
      client.connect({
        host: '127.0.0.1',
        port,
        username: 'packaged-test',
        password: 'anything', // this fixture server accepts any password
        hostVerifier: (_key: Buffer, verify: (valid: boolean) => void) => verify(true), // TOFU UX is covered elsewhere — only runtime function is under test
      });
    });

    const output = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(
        () => reject(new Error(`packaged ssh2 shell round-trip timed out; got: ${JSON.stringify(buf)}`)),
        15_000,
      );
      channel.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        if (buf.includes('READY') && buf.includes('ECHO:hi')) {
          clearTimeout(timer);
          resolve(buf);
        }
      });
      channel.write('hi\r\n');
    });
    expect(output).toContain('READY');
    expect(output).toContain('ECHO:hi');

    // setWindow (resize) + the close teardown path — the same calls ssh-session.ts's
    // adapter makes post-channel.
    channel.setWindow(30, 100, 0, 0);
    await new Promise<void>((resolve) => {
      channel.on('close', () => resolve());
      channel.close();
    });
    client.end();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
