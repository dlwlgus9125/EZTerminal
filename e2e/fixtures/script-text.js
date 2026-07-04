// run-script e2e fixture: no default export + stdout/stderr output renders as
// a text block with BOTH streams merged (mirrors the external-command rule).
process.stdout.write('hello from stdout\n');
process.stderr.write('hello from stderr\n');
