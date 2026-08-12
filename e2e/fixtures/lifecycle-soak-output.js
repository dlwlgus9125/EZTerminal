// Long-lived, low-rate PTY workload for the desktop lifecycle soak.
// Output stays frequent enough to prove a parked presentation continues to
// consume the run stream, without turning the memory gate into a flood test.
const label = process.argv[2] ?? 'unlabelled';
let line = '';
let tick = 0;

process.stdout.write(`READY ${label}\r\n`);
process.stdin.setEncoding('utf8');
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  for (const character of chunk) {
    if (character === '\u0003') process.exit(0);
    if (character === '\r' || character === '\n') {
      if (line) process.stdout.write(`INPUT ${label} ${line}\r\n`);
      line = '';
    } else if (character === '\u007f' || character === '\b') {
      line = line.slice(0, -1);
    } else {
      line += character;
    }
  }
});

setInterval(() => {
  tick += 1;
  process.stdout.write(`TICK ${label} ${tick}\r\n`);
}, 1_000);
