// run-script e2e fixture: never resolves — proves Cancel actually tears the
// script-host process down (a busy loop can't be reasoned out of; it can only
// be OS-killed). Prints periodically so the block visibly has output before
// cancel.
process.stdout.write('started\n');
let i = 0;
for (;;) {
  i++;
  if (i % 2_000_000 === 0) process.stdout.write(`tick ${i}\n`);
}
