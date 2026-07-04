// Diagnostic fixture (scroll-fixer investigation): same real ink-style (claude)
// trigger burst as ink-trigger-longlived.js, then an initial flood (to push past
// one screen), then CONTINUES streaming one new numbered line every 150ms
// indefinitely — simulating an in-progress token-by-token response. Used to test
// whether new incoming PTY output yanks a scrolled-up viewport back to the
// bottom (the classic "can't read history because it keeps jumping back down"
// symptom), as opposed to a one-shot flood which can't distinguish that from a
// simple "scroll never worked at all" failure.
process.stdout.write(
  '\x1b[?2004h\x1b[?1004h\x1b[?2031h\x1b[<u\x1b[>1u\x1b[>4;2m\x1b[>0q\x1b[?2026h\x1b[?2026l',
);
process.stdout.write('INK-STYLE-READY\r\n');
for (let i = 1; i <= 60; i++) {
  process.stdout.write(`LINE-${String(i).padStart(3, '0')}\r\n`);
}
let n = 61;
setInterval(() => {
  process.stdout.write(`LINE-${String(n).padStart(3, '0')}\r\n`);
  n += 1;
}, 150);
