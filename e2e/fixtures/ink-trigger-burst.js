// Adaptive-render e2e fixture: replays the EXACT ink-style (claude) trigger burst
// captured by the M0a spike (.omc/research/pty-signal-measurements.md §4/§7,
// claude.raw at t≈2987ms) — bracketed paste + focus-tracking is the confirmed,
// zero-false-positive, sigil-free claude/codex signal. Not a synthetic/invented
// sequence — copied verbatim from the real capture.
process.stdout.write(
  '\x1b[?2004h\x1b[?1004h\x1b[?2031h\x1b[<u\x1b[>1u\x1b[>4;2m\x1b[>0q\x1b[?2026h\x1b[?2026l',
);
process.stdout.write('INK-STYLE-READY\r\n');
setTimeout(() => process.exit(0), 300);
