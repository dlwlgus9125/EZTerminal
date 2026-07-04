// e2e fixture (AC-8): proves an external command's stdin is explicitly closed
// rather than left open-but-unwritten. If stdin were left connected with
// nothing writing to it (the pre-fix default), 'end' would never fire and this
// process — and the block waiting on it — would hang forever. Exits with a
// distinctive code once EOF confirms the runner closed stdin.
process.stdout.write('waiting-for-stdin\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(42));
