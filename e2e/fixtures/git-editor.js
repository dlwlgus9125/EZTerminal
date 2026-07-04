// e2e fixture: a GIT_EDITOR shim. `git commit` with no `-m` spawns
// `$GIT_EDITOR <commit-msg-file>` and waits for it to exit — this stands in for
// a real interactive editor (vim/nano/notepad) without needing a real terminal
// UI, while still proving the bare `git commit` PTY spawn actually waits for and
// completes a child editor process.
const fs = require('fs');
const file = process.argv[2];
fs.writeFileSync(file, 'ezterm-e2e-editor-commit\n');
