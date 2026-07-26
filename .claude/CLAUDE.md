@../AGENTS.md

# EZTerminal project context

- The desktop application is Electron + React + TypeScript, the Android companion is under `mobile/`, and the Windows remote host is Rust under `native/remote-host/`.
- Treat `release/version.json` as the release-version contract.
- Start with `README.md` for product behavior, `docs/ROADMAP.md` for current direction, and `docs/release/README.md` for release work.
- Preserve signing material under `.release-secrets/` and inspect registered Git worktrees before cleanup or workspace operations.
