// Direct-Codex keyboard/clipboard E2E fixture. Its filename and shim basename
// deliberately exercise the same direct-command classification as `codex.cmd`
// without requiring the real CLI or authentication in CI. `--xterm` emits the
// same high-confidence bracketed-paste/focus burst used by interactive agents.
if (process.argv.includes('--xterm')) {
  process.stdout.write('\x1b[?2004h\x1b[?1004h');
}
process.stdout.write('FAKE-CODEX-READY COPY-ME\r\n');
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();

let line = '';
let received = '';
process.stdin.on('data', (data) => {
  received += data;
  if (data.includes('\x03')) process.stdout.write('CTRL-C-RECEIVED\r\n');
  if (data.includes('\x04')) process.stdout.write('CTRL-D-RECEIVED\r\n');
  if (data.includes('\x06')) process.stdout.write('CTRL-F-RECEIVED\r\n');
  if (data.includes('\x10')) process.stdout.write('CTRL-P-RECEIVED\r\n');
  if (data.includes('\x16')) process.stdout.write('CTRL-V-RECEIVED\r\n');
  if (data.includes('\x1b')) process.stdout.write('ESC-RECEIVED\r\n');
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
