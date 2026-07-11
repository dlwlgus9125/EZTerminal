// TUI-scroll-parity e2e fixture: a vim-like full-screen TUI — alternate
// screen WITHOUT mouse tracking. Long-lived variant of alt-screen.js (which
// exits after 300ms) that also echoes every stdin chunk back as hex, so the
// spec can prove the wheel→arrow-key fallback ROUND-TRIPS through ConPTY
// into the child (keyboard-path input translation is reliable for a Node
// child, unlike mouse reports — see mouse-mode-tui.js).
process.stdout.write('\x1b[?1049h');
process.stdout.write('ALT-SCREEN-READY\r\n');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (b) => {
  process.stdout.write('GOT:' + Buffer.from(b).toString('hex') + '\r\n');
});
setInterval(() => {}, 1000);
