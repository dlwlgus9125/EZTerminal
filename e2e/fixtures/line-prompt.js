// Adaptive-render e2e fixture: a line-oriented input prompt with NO trigger signals
// (mirrors M0a's real node-readline-prompt / credential-prompt captures — plain
// render, input must be wired) — typed echo + Backspace + Ctrl+C round trip, all
// through the plain-mode minimal keyset (B-R4).
process.stdout.write('name: ');
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
let buf = '';
process.stdin.on('data', (d) => {
  if (d === '\x03') {
    process.stdout.write('\r\nSIGINT\r\n');
    process.exit(0);
  }
  if (d === '\r') {
    process.stdout.write(`\r\nHELLO ${buf}\r\n`);
    process.exit(0);
  }
  if (d === '\x7f') {
    if (buf.length > 0) {
      buf = buf.slice(0, -1);
      process.stdout.write('\b \b');
    }
    return;
  }
  buf += d;
  process.stdout.write(d);
});
