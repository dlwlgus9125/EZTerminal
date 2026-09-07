// Direct-Codex keyboard/clipboard E2E fixture. Its filename and shim basename
// deliberately exercise the same direct-command classification as `codex.cmd`
// without requiring the real CLI or authentication in CI. `--xterm` emits the
// same high-confidence bracketed-paste/focus burst used by interactive agents.
// The version and app-server branches also let structured-Agent E2E cross the
// production provider discovery/review/JSON-RPC seam without using the host's
// installed Codex version or account.
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const versionFile = process.env.TMPDIR
  ? path.join(process.env.TMPDIR, 'ezterminal-e2e-codex-version.txt')
  : undefined;
let fixtureVersion = '0.153.4';
if (versionFile) {
  try {
    fixtureVersion = fs.readFileSync(versionFile, 'utf8').trim() || fixtureVersion;
  } catch {
    // Most fixture consumers do not need mutable version state.
  }
}

if (args.includes('--version')) {
  process.stdout.write(`codex-cli ${fixtureVersion}\n`, () => process.exit(0));
} else if (args[0] === 'app-server') {
  let input = '';
  let nextThread = 0;
  let nextTurn = 0;
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const respond = (frame, result) => write({ jsonrpc: '2.0', id: frame.id, result });

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    for (;;) {
      const newline = input.indexOf('\n');
      if (newline < 0) break;
      const line = input.slice(0, newline).trim();
      input = input.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      if (frame.id === undefined) continue;
      switch (frame.method) {
        case 'initialize':
          respond(frame, {
            userAgent: `codex-cli/${fixtureVersion}`,
            codexHome: 'C:\\fixture\\.codex',
            platformFamily: 'windows',
            platformOs: 'windows',
          });
          break;
        case 'model/list':
          respond(frame, {
            data: [{
              id: 'gpt-5.6-fixture',
              model: 'gpt-5.6-fixture',
              displayName: 'GPT 5.6 Fixture',
              isDefault: true,
            }],
            nextCursor: null,
          });
          break;
        case 'thread/start': {
          const threadId = `fixture-thread-${++nextThread}`;
          respond(frame, { thread: { id: threadId }, model: 'gpt-5.6-fixture' });
          break;
        }
        case 'turn/start': {
          const threadId = frame.params?.threadId;
          const turnSequence = ++nextTurn;
          const turnId = `fixture-turn-${turnSequence}`;
          respond(frame, { turn: { id: turnId, status: 'inProgress', items: [] } });
          setTimeout(() => {
            write({
              jsonrpc: '2.0',
              method: 'turn/started',
              params: { threadId, turn: { id: turnId, status: 'inProgress', items: [] } },
            });
            write({
              jsonrpc: '2.0',
              method: 'item/completed',
              params: {
                threadId,
                turnId,
                completedAtMs: Date.now(),
                item: {
                  id: `fixture-message-${turnSequence}`,
                  type: 'agentMessage',
                  text: 'Structured Codex fixture ready.',
                  phase: null,
                },
              },
            });
            write({
              jsonrpc: '2.0',
              method: 'turn/completed',
              params: {
                threadId,
                turn: { id: turnId, status: 'completed', error: null, items: [] },
              },
            });
          }, 10);
          break;
        }
        case 'thread/unsubscribe':
          respond(frame, { status: 'notLoaded' });
          break;
        case 'turn/interrupt':
        case 'thread/settings/update':
          respond(frame, {});
          break;
        default:
          write({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32601, message: `Unsupported fixture method: ${frame.method}` },
          });
      }
    }
  });
  process.stdin.resume();
} else {
  const scrollbackScenario = process.env.EZTERMINAL_E2E_CODEX_SCROLLBACK === '1';
  const projectMapScenario = process.env.EZTERMINAL_E2E_PROJECT_MAP_AGENT === '1';
  if (scrollbackScenario) {
    // Codex normally owns the alternate screen. That buffer has no scrollback,
    // so overflowing it reproduces the missing-middle transcript symptom. The
    // product-owned launch must opt into Codex's inline mode to keep all markers.
    if (!args.includes('--no-alt-screen')) process.stdout.write('\x1b[?1049h');
    process.stdout.write('\x1b[?2004h');
    setTimeout(() => {
      const markers = Array.from(
        { length: 80 },
        (_, index) => `CODEX-SEQ-${String(index + 1).padStart(3, '0')}`,
      );
      process.stdout.write(`${markers.join('\r\n')}\r\n`);
    }, 100);
  } else {
    if (args.includes('--xterm') || projectMapScenario) {
      process.stdout.write('\x1b[?2004h\x1b[?1004h');
    }
    process.stdout.write('FAKE-CODEX-READY COPY-ME\r\n');
    if (args.includes('--model')) process.stdout.write(`CLI-MODEL:${args[args.indexOf('--model') + 1]}\r\n`);
  }

  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();

  let line = '';
  let received = '';
  let interrupted = false;
  process.stdin.on('data', (data) => {
    received += data;
    if (data.includes('\x03')) process.stdout.write('CTRL-C-RECEIVED\r\n');
    if (data.includes('\x04')) process.stdout.write('CTRL-D-RECEIVED\r\n');
    if (data.includes('\x06')) process.stdout.write('CTRL-F-RECEIVED\r\n');
    if (data.includes('\x10')) process.stdout.write('CTRL-P-RECEIVED\r\n');
    if (data.includes('\x16')) process.stdout.write('CTRL-V-RECEIVED\r\n');
    if (data.includes('\x1b')) {
      interrupted = true;
      process.stdout.write('ESC-RECEIVED\r\n');
    }
    if (received.includes('first\nsecond')) {
      process.stdout.write('MULTILINE-PASTE-RECEIVED\r\n');
      received = '';
    }

    const printable = data.replace(/[\x00-\x1f\x7f]/gu, '');
    if (printable) process.stdout.write(`TEXT:${JSON.stringify(printable)}\r\n`);

    for (const character of data) {
      if (character === '\x15') {
        line = '';
        continue;
      }
      if (character === '\r' || character === '\n') {
        // A mounted xterm can answer terminal capability/focus queries between
        // Escape and the submitted line. Those replies are not user text, so
        // accept the recovery instruction at the end of the accumulated input.
        if (line.trim().endsWith('continue') && interrupted) {
          process.stdout.write('RECOVERY-SEQUENCE\r\n');
          interrupted = false;
        }
        if (line.trim() === '/exit' || line.trim() === '/quit') {
          process.stdout.write('EXPLICIT-EXIT\r\n');
          process.exit(0);
        }
        line = '';
      } else if (character >= ' ') {
        line += character;
      }
    }
  });
}
