// PTY e2e fixture: a CLI-agent stand-in for the mobile resume-stall spec
// (remote-resume-stall.spec.ts). Two jobs:
//   1. FLOOD — emit a continuous, numbered output stream (~64 KB per 100 ms,
//      "SEQ:<n>" markers) so the primary byte-ack window fills within seconds
//      once nothing can ack it (the reported freeze crosses PTY_HIGH_WATER
//      = 1 MiB roughly 1.6 s after acks stop).
//   2. ESC PROBE — print a visible ESC-RECEIVED marker when an ESC byte
//      arrives on stdin, so "input reaches the child but nothing renders"
//      is distinguishable from "input never arrives".
// Prints FLOOD-READY first; stays alive until the PTY is killed.
process.stdout.write('FLOOD-READY\r\n');
// Raw mode (same as fake-codex/codex-fixture.js): cooked ConPTY input buffers
// a bare ESC byte until Enter, so the probe would never fire without it.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (d) => {
  if (d.includes('\x1b')) process.stdout.write('\r\nESC-RECEIVED\r\n');
  if (d.includes('__EZTERMINAL_TEST_EXIT__')) process.exit(0);
});

let seq = 0;
const PAD = 'x'.repeat(1000);
setInterval(() => {
  let out = '';
  for (let i = 0; i < 64; i += 1) {
    seq += 1;
    out += `SEQ:${seq} ${PAD}\r\n`;
  }
  process.stdout.write(out);
}, 100);
