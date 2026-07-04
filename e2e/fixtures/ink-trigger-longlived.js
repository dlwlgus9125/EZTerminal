// Adaptive-render e2e fixture: same real ink-style (claude) trigger burst as
// ink-trigger-burst.js (verbatim from the M0a capture — see that file's header),
// but stays alive afterward (setInterval, like pty-echo.js) instead of exiting
// after 300ms. Used where a test needs a DETERMINISTIC "still running, still
// upgraded" window to assert against (e.g. tui-takeover.spec.ts), rather than
// racing a fixed timeout — the short-lived variant remains the right fixture
// for adaptive-render.spec.ts's "does it upgrade at all" assertions.
process.stdout.write(
  '\x1b[?2004h\x1b[?1004h\x1b[?2031h\x1b[<u\x1b[>1u\x1b[>4;2m\x1b[>0q\x1b[?2026h\x1b[?2026l',
);
process.stdout.write('INK-STYLE-READY\r\n');
setInterval(() => {}, 1000);
