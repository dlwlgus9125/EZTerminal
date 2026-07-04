// Adaptive-render e2e fixture: enters the alternate screen buffer — a real,
// legitimate high-confidence trigger per M0a (.omc/research/pty-signal-measurements.md
// §7 trigger #1). claude/codex did not use it in the captured window, but it is kept
// in the trigger set because it was never observed as ConPTY or progress-renderer
// noise anywhere in the dataset. Proves the immediate-upgrade-to-xterm path.
process.stdout.write('\x1b[?1049h');
process.stdout.write('ALT-SCREEN-READY\r\n');
setTimeout(() => process.exit(0), 300);
