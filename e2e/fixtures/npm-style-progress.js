// Adaptive-render e2e fixture: a long-running spinner/progress-style output with NO
// trigger signals — mirrors M0a's real npm-install/pnpm-add captures (zero alt-screen,
// bracketed paste, mouse/focus, or app-cursor-keys; only repeated in-place line
// rewrites via a bare carriage return, which ConPTY's own repaint bracketing may wrap
// in noise this fixture never emits itself). This is B-R1's decisive adversarial case:
// a long-running plain command must NOT be misdetected as a TUI and upgraded to xterm.
const frames = ['-', '\\', '|', '/'];
let i = 0;
const timer = setInterval(() => {
  process.stdout.write(`\rinstalling... ${frames[i % frames.length]} ${i}%`);
  i++;
  if (i > 60) {
    clearInterval(timer);
    process.stdout.write('\rinstalling... done\r\n');
    process.exit(0);
  }
}, 20);
