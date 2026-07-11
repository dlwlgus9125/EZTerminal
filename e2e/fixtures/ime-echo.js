// IME e2e fixture (ime-input.spec.ts): upgrades the block to xterm mode with
// the same bracketed-paste trigger claude/codex emit (see
// ink-trigger-longlived.js), then echoes each stdin chunk back framed as
// RX<"...json..."> so specs can assert EXACTLY what bytes reached the PTY —
// including invisible duplicates the cooked-echo path would blur together.
process.stdout.write('\x1b[?2004h');
process.stdout.write('IME-READY\r\n');
// Raw mode: without it ConPTY line-buffers stdin (nothing reaches this
// process until Enter) and cook-echoes keystrokes, blurring the assertions.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdin.on('data', (d) => {
  process.stdout.write('RX<' + JSON.stringify(d) + '>\r\n');
});
