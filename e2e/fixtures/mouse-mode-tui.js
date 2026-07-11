// TUI-scroll-parity e2e fixture: a claude-like full-screen TUI — alternate
// screen + SGR button-event mouse tracking (?1002h/?1006h, the same modes
// claude v2.1.x enables at startup per the 2026-07-11 ConPTY capture). Stays
// alive (like pty-echo.js) and consumes stdin so the mouse reports xterm
// sends have a live reader; the spec asserts on the RENDERER side (the
// __ezTerm seam: protocol activation + the exact bytes wheel emits), not on
// an echo — a plain Node child cannot observe translated mouse input
// (libuv drops MOUSE_EVENT records), only claude's own runtime can.
process.stdout.write('\x1b[?1049h\x1b[?1002h\x1b[?1006h');
process.stdout.write('MOUSE-MODE-READY\r\n');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', () => {});
setInterval(() => {}, 1000);
