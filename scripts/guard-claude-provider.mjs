#!/usr/bin/env node
/**
 * The Claude provider launches the Claude Code CLI the user installed. Two
 * things about that arrangement broke it silently once, and this guard keeps
 * them from coming back — by reading source, not by running it.
 *
 *   1. The packaged app ships only the dependencies `forge.config.ts` copies.
 *      `@anthropic-ai/*` is not among them, so a runtime `require.resolve` of
 *      one of those packages always throws inside app.asar. It resolved fine in
 *      the dev tree, so the failure was invisible until an installed build was
 *      opened: the resolver fell into its `catch`, returned null, and the
 *      provider reported itself unavailable with no indication why.
 *   2. The executable version gate must stay a supported *range*. Pinning it to
 *      one exact build made every auto-updated Claude Code install unenablable,
 *      because the user's CLI is never the exact version the pin names.
 *
 * Launch-time drift protection is deliberately NOT relaxed and is not checked
 * here: `assertReady` still requires the on-disk version to equal the reviewed
 * descriptor's version.
 *
 * Run: node scripts/guard-claude-provider.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function read(relative) {
  return readFileSync(path.join(root, relative), 'utf8');
}

function sourceFiles(relativeDirectory) {
  const absolute = path.join(root, relativeDirectory);
  return readdirSync(absolute, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name))
    .map((entry) => path.relative(root, path.join(entry.parentPath ?? absolute, entry.name)));
}

// ── 1. no runtime resolution of a package the installer does not ship ───────
const RESOLVE_UNSHIPPED = /(?:require|moduleRequire|createRequire\([^)]*\))\s*\.?\s*resolve\(\s*[`'"][^`'"]*@anthropic-ai\//u;

for (const relative of [...sourceFiles('src/main'), ...sourceFiles('src/shared')]) {
  const source = readFileSync(path.join(root, relative), 'utf8');
  if (RESOLVE_UNSHIPPED.test(source)) {
    failures.push(
      `${relative.split(path.sep).join('/')} resolves an @anthropic-ai package at runtime. `
        + 'Those packages are not copied into the packaged app, so the lookup throws '
        + 'only in an installed build. Resolve the user-installed CLI instead.',
    );
  }
}

// ── 2. the executable version gate stays a range ────────────────────────────
const adapter = read('src/main/claude-provider-adapter.ts');

if (!/export const CLAUDE_CLI_MINIMUM_SUPPORTED_VERSION = '\d+\.\d+\.\d+';/u.test(adapter)) {
  failures.push(
    'src/main/claude-provider-adapter.ts must declare CLAUDE_CLI_MINIMUM_SUPPORTED_VERSION '
      + 'as the oldest supported Claude Code CLI.',
  );
}

if (/version\s*===\s*CLAUDE_CLI_MINIMUM_SUPPORTED_VERSION/u.test(adapter)) {
  failures.push(
    'src/main/claude-provider-adapter.ts compares an installed Claude Code version with '
      + 'strict equality against the minimum. The user\'s CLI auto-updates and would never '
      + 'match; compare a supported range instead.',
  );
}

if (!/compareSemanticVersions\(candidate, minimum\) >= 0/u.test(adapter)) {
  failures.push(
    'src/main/claude-provider-adapter.ts no longer accepts Claude Code builds at or above '
      + 'the minimum supported version.',
  );
}

if (failures.length > 0) {
  process.stderr.write(`${failures.map((line) => `- ${line}`).join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(
  'Claude provider guard: no unshipped runtime resolution, version gate is a supported range.\n',
);
