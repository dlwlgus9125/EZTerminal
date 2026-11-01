/*
 * Test-only preload for `scripts/verify-ux-live.mjs --stub` (`electron -r`). The real app runs the real CLIs, and this points
 * them at the loopback stubs of scripts/long-run-probe-kit.mjs, because a usage limit cannot be had on demand. Nothing in
 * src/ knows about it, and the product's environment allow-list stays as it is.
 *
 * The harness launches the app with a scratch home, so the person's credentials are out of reach of the app and of every
 * command it runs. This adds what the allow-list keeps out, to the two CLIs only: the stub's address and a dummy credential.
 * The harness's credential audit is what proves it: the stubs keep one boolean per request, whether it was the dummy.
 */
'use strict';

const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');

const stubEnvironment = process.env.EZ_LIVE_STUB_ENV;

const isCli = (command, args) => /claude|codex/iu.test([command, ...(Array.isArray(args) ? args : [])].join(' '));

if (stubEnvironment) {
  const added = JSON.parse(stubEnvironment);
  const spawn = childProcess.spawn;
  childProcess.spawn = function stubbedSpawn(command, args, options) {
    if (!isCli(command, args)) return spawn.apply(this, arguments);
    const hasArgs = Array.isArray(args);
    const launch = hasArgs ? options : args;
    const next = { ...launch, env: { ...(launch?.env ?? process.env), ...added } };
    return hasArgs ? spawn.call(this, command, args, next) : spawn.call(this, command, next);
  };
  syncBuiltinESMExports();
}
