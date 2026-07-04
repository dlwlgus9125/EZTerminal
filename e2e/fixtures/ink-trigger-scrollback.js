// Diagnostic fixture (scroll-fixer investigation): same real ink-style (claude)
// trigger burst as ink-trigger-longlived.js (verbatim from the M0a capture),
// but ALSO floods 200 numbered lines into scrollback right after the
// READY marker, then stays alive via setInterval. Used by a diagnostic e2e
// test to prove/disprove whether wheel-up over a takeover xterm actually
// scrolls the viewport up into that flooded scrollback.
process.stdout.write(
  '\x1b[?2004h\x1b[?1004h\x1b[?2031h\x1b[<u\x1b[>1u\x1b[>4;2m\x1b[>0q\x1b[?2026h\x1b[?2026l',
);
process.stdout.write('INK-STYLE-READY\r\n');
for (let i = 1; i <= 200; i++) {
  process.stdout.write(`LINE-${String(i).padStart(3, '0')}\r\n`);
}
process.stdout.write('BOTTOM-MARKER\r\n');
setInterval(() => {}, 1000);
