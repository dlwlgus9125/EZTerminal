// Sustained plain PTY output that crosses the renderer's 8 MiB retention
// ceiling. This is intentionally larger than the ordinary 1.1 MiB flow-control
// fixture so the release benchmark measures steady-state prefix pruning.
const line = 'r'.repeat(1000) + '\n';
const totalLines = 12_000; // ~12 MiB
for (let index = 0; index < totalLines; index += 1) process.stdout.write(line);
process.stdout.write('RETENTION-PRESSURE-DONE\r\n');
