// Adaptive-render e2e fixture (fix-ctrlc-treekill): proves the shim de-sugar
// fix — collapsing the cmd.exe -> node.exe tree into a single PTY-spawned
// node.exe (agent as console group leader) — lets Ctrl+C reach THIS process as
// plain input instead of the group's CTRL_C_EVENT being intercepted by
// cmd.exe's batch-job terminator and killing the whole tree. Raw mode disables
// ENABLE_PROCESSED_INPUT so \x03 arrives as a data byte, not a signal: on
// Ctrl+C, print INTERRUPTED and STAY ALIVE; on 'q', print STILL-ALIVE and exit
// cleanly (models line-prompt.js's raw-mode reader).
process.stdout.write('SURVIVOR-READY\r\n');
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdin.on('data', (d) => {
  if (d === '\x03') {
    process.stdout.write('INTERRUPTED\r\n');
    return;
  }
  if (d === 'q') {
    process.stdout.write('STILL-ALIVE\r\n');
    process.exit(0);
  }
});
