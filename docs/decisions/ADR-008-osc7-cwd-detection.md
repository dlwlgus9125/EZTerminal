# ADR-008: OSC 7 CWD Detection with Win32 Fallback

## Status
Accepted

## Context
Files panel needs to track the active PTY session's current working directory. Three target shells: PowerShell, cmd.exe, WSL bash/zsh. OSC 7 (`\e]7;file://hostname/path\a`) is the standard terminal escape sequence for reporting CWD, supported natively by bash/zsh and configurable in PowerShell. However, cmd.exe has no OSC 7 support and default PowerShell does not emit it without profile configuration.

Forces:
- Instant CWD detection for responsive Files panel UX
- Zero-configuration experience for all shell types
- Minimal CPU overhead when idle
- xterm.js already parses OSC sequences

## Decision
Use OSC 7 as the primary CWD detection mechanism. When no OSC 7 is received within 5 seconds of Files panel open, fall back to 2-second polling via Win32 API (NtQueryInformationProcess) to query the PTY child process's CWD. Polling stops when OSC 7 is detected or the panel closes.

## Consequences
- Positive: Instant CWD updates for OSC 7-capable shells; zero-config for cmd.exe via fallback
- Positive: Fallback polling has low overhead (one syscall per 2s, only when panel is open)
- Negative: Two code paths to maintain (OSC 7 parser + Win32 API binding)
- Negative: Win32 fallback adds platform-specific native code
- Follow-up review trigger: If PowerShell 8+ adds native OSC 7, revisit to remove fallback for that shell
