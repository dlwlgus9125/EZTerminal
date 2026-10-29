// Fake global npm for the AI management program update. It lives in the same temporary prefix as
// the fake Codex shim, so `npm prefix -g` is its own folder. The registry's latest version and the
// installed version are files beside the fake Codex version file (TMPDIR), which the fake Codex reads.
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const state = process.env.TMPDIR;
const latestFile = state ? path.join(state, 'ezterminal-e2e-codex-latest.txt') : undefined;
const versionFile = state ? path.join(state, 'ezterminal-e2e-codex-version.txt') : undefined;
const read = (file, fallback) => {
  try { return fs.readFileSync(file, 'utf8').trim() || fallback; } catch { return fallback; }
};

if (args[0] === 'prefix' && args[1] === '-g') {
  process.stdout.write(`${__dirname}\n`);
} else if (args[0] === 'view' && args[1] === '@openai/codex' && args[2] === 'version') {
  process.stdout.write(`${read(latestFile, '0.153.4')}\n`);
} else if (args[0] === 'install' && args[1] === '-g' && /^@openai\/codex@\d+\.\d+\.\d+$/u.test(args[2] ?? '')) {
  if (versionFile) fs.writeFileSync(versionFile, args[2].split('@').pop(), 'utf8');
  if (state) fs.appendFileSync(path.join(state, 'ezterminal-e2e-npm-installs.txt'), `${args[2]}\n`);
  process.stdout.write('changed 1 package in 1s\n');
} else {
  process.stderr.write(`fake npm: unsupported ${args.join(' ')}\n`);
  process.exitCode = 1;
}
