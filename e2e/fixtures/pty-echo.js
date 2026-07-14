// PTY e2e fixture: an interactive program that proves the bidirectional PTY path.
// Prints READY on start, then echoes each stdin chunk back prefixed with "ECHO:".
// Stays alive (stdin data listener) until the PTY is killed (Cancel).
process.stdout.write('READY\r\n');
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdin.on('data', (d) => {
  process.stdout.write('ECHO:' + d);
  if (d.includes('__EZTERMINAL_TEST_EXIT__')) process.exit(0);
});
