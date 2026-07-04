// Adaptive-render e2e fixture: >1MB of plain output with no trigger signals — proves
// plain mode's self-driven, receive-immediate ack (M3) avoids the backpressure
// deadlock that only xterm's flush-driven ack used to guard against (there is no
// xterm mounted yet in plain mode to drive that flush).
const line = 'x'.repeat(1000) + '\n';
const totalLines = 1100; // ~1.1MB, safely over the 1MiB high-water mark
for (let i = 0; i < totalLines; i++) process.stdout.write(line);
process.stdout.write('LARGE-OUTPUT-DONE\r\n');
