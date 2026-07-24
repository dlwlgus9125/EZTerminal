<div align="center">

<img src="appicon.png" width="140" alt="EZTerminal" />

# EZTerminal

**A structured-data shell terminal for Windows — pipe typed tables, not text.**

Block-based UI · themes &amp; CRT effects · system monitor · SSH · pair your phone as a remote

![release](https://img.shields.io/badge/release-v1.0.4-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Android-informational)
![built with](https://img.shields.io/badge/built%20with-Electron%20·%20React%20·%20TypeScript-9cf)

<img src="docs/screenshots/01-hero.png" width="840" alt="EZTerminal — a structured-data pipeline rendered as a table" />

</div>

---

## What is EZTerminal?

EZTerminal is a desktop terminal that treats command output as **structured data** instead of flat
text. Built-ins like `ls`, `gen-rows`, `ps` and `history` emit **typed rows** you can filter and sort
with real pipelines:

```
gen-rows 5 | where n > 2 | sort-by n
ls | where size > 1000 | sort-by size
```

Results render as a live, **virtualized table** (100,000+ rows stay smooth). Every command is a
collapsible **block** with its own status, working directory and output — and external / TUI programs
(`node`, `git`, `claude`, `codex`, …) are auto-detected and run in a full PTY.

It also ships a companion **Android app** that pairs with the desktop through Tailscale, WireGuard,
or another explicitly trusted VPN to run terminal sessions and control the visible Windows desktop.

## Features

### 🧩 Structured-data shell
- Typed pipelines — `where`, `sort-by`, `gen-rows` over real columns, not text
- Virtualized tables (100k+ rows) and variables (`let threshold = 2`)
- Block UI: per-command status, cwd, collapse / dismiss
- Adaptive rendering: plain text vs full PTY / xterm, auto-detected

### 🎨 Themes &amp; CRT effects
Light, Dark and a **Matrix CRT** theme, plus importable custom theme mods. Toggle scanlines, phosphor
glow, a moving CRT roll bar, flicker, jitter and noise — each with live sliders — and pick any bundled
monospace font.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/02-matrix-crt.png" alt="Matrix CRT theme" /></td>
<td width="50%"><img src="docs/screenshots/04-settings.png" alt="Themes, fonts and CRT effect controls" /></td>
</tr>
</table>

### 📊 System monitor
A btop-style panel: per-core CPU, memory breakdown, network, disk, live connections and a process
list — plus optional live **packet capture** (Npcap).

<img src="docs/screenshots/03-status.png" width="840" alt="System status panel" />

### 🪟 Tabs, splits &amp; layouts
An independent shell session per tab, drag-to-rearrange splits, savable presets and layout persistence
across restarts. Windows Terminal-parity keys include selection-aware copy, text paste aliases,
context menus and configurable scrollback. In ordinary PTYs, `Ctrl+C` still interrupts the foreground
program without killing the whole tree.

Use the Command Center button for Quick Open across panes, command history, saved Quick Commands,
workspace files, presets and agent launchers; `Ctrl/Cmd+Shift+P` opens commands and actions. `Ctrl+P`
is left to terminal programs. Full xterm blocks use `Ctrl/Cmd+Shift+F` for search and also support safe
modifier-click web links, Unicode 11 and WebGL with DOM fallback.

Directly launched Codex sessions add a narrow safety layer: with no selection, `Ctrl+C` and `Ctrl+D`
are blocked so Codex exits only through `/exit`, `/quit`, or the explicit **Force stop** button; `Esc`
still cancels the current Codex task. With a selection, `Ctrl+C` copies as usual. `Ctrl+V` gives an
image-bearing clipboard to Codex itself, so Codex owns the image attachment; EZTerminal does
not create or expose a temporary path. `Ctrl+Shift+V` and `Shift+Insert` always paste clipboard text.
Multiline and larger-than-5-KiB text pastes ask for confirmation by default, with independent toggles
under **Settings → Terminal & Safety**. Wrapper, pipeline, SSH, and non-Codex PTYs keep their normal
control-key behavior.

<img src="docs/screenshots/05-splits.png" width="840" alt="Split panes running independent sessions" />

### 📁 Files &amp; 🔐 SSH
A built-in file explorer (desktop and mobile) and an SSH client with trust-on-first-use host-key
verification. Text and Markdown, bounded PNG/JPEG/GIF/WebP images and PDF metadata have safe previews;
desktop files can be dragged into the active terminal as quoted paths without executing them.

`ssh-connect` accepts either `user@host` or a safe OpenSSH config alias. An authenticated SSH block
shows a copyable connection id that can be used for loopback-only local forwards:

```bash
ssh-connect production
ssh-forward-start <connection-id> db.internal 5432 --local-port 0
ssh-forward-list <connection-id>
ssh-forward-stop <connection-id> <forward-id>
```

Terminal output paths become previews only after an explicit gesture: Ctrl/Cmd-click on desktop, or
tap followed by Preview/Copy on Android. Resolution is restricted to the command's local workspace;
remote SSH and out-of-workspace paths are not opened. Preview consumes a main-owned, short-lived,
one-shot file-identity capability so the target cannot be swapped between resolution and open.

### Git worktrees

Worktree operations stay in the terminal and render as structured rows. `open` creates a normal
terminal tab rooted at the validated worktree. Removal is intentionally conservative: only clean,
idle, unlocked worktrees created by EZTerminal can be removed, without `--force`.

```bash
worktree list
worktree create feature/name --base "HEAD"
worktree open <worktree-id>
worktree remove <worktree-id>
```

The Android client exposes only `list` and `open`; creation and removal remain desktop-only.

### Agent attention
Codex, Claude and configured CLI sessions surface working/waiting/approval/error state in terminal tabs
and the Agent Hub. Optional provider hooks improve lifecycle accuracy, waiting agents accept an explicit
one-line follow-up, and desktop notifications can focus the owning terminal without exposing prompts or
transcripts. The paired Android client mirrors the same activity view.

### 📱 Mobile remote control
Pair the Android app to run and mirror desktop sessions from your phone.
**Off by default, token-gated and origin-checked** — see [SECURITY.md](SECURITY.md).
The desktop bearer token uses OS-backed encryption on Windows, while saved Android credentials use
Keystore-backed storage with no plaintext fallback. A transient network
loss keeps the mounted workspace and may resume bounded active runs in place for up to five minutes;
an invalid token stops retrying and asks the user to pair again.

On Windows 10 22H2/11 x64, **More → PC Control** can also stream the unlocked,
visible PC screen over VPN-bound WebRTC and provide trackpad/direct-touch,
physical or Korean IME keyboard input, special keys, and explicit text
clipboard actions. Only one phone controls the GUI at a time; the local display
and input remain active, and the desktop banner, tray, or Remote panel can
disconnect it at any time.

PC Control is enabled in supported Windows builds, but the capability is
advertised only while the remote bridge is enabled, a trusted
Tailscale/WireGuard adapter is selected, and the installed LocalSystem host
service is ready. Starting control additionally requires a successful
active-session agent handshake. Missing or unhealthy native components fail
closed without disabling terminal-only remote access. In 1.0.4, frame
capture/encoding and actual input injection still run in the normal-user
transport; lock/UAC secure-desktop control and Ctrl+Alt+Delete are unavailable.

Desktop Settings also includes risk-aware pane-close confirmation and a default-off OSC 52 clipboard
write option. After confirmation, the interpreter atomically compares the expected active run IDs and
fails closed if state changed. Terminal-originated clipboard queries are never answered, writes are
size/rate limited, and semantic attach replay renders OSC 52 without repeating clipboard side effects.

Local PTY runs keep a bounded headless terminal snapshot for late mobile attach. Reconnect applies the
serialized screen state and its exact output tail before live bytes are released; if that continuity
cannot be proved, EZTerminal visibly falls back to the bounded recent-output ring. SSH runs currently
fail closed for late attach instead of presenting an incomplete terminal.

## Download

Grab both official 1.0 downloads from the
[**Releases**](https://github.com/dlwlgus9125/EZTerminal/releases/latest) page:

- Windows 10 22H2 / Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer: `EZTerminal-Android-1.0.4-vc25.apk`

> The Windows build is currently **unsigned**, so Windows SmartScreen may warn about an "unknown publisher" on
> first run. Choose *More info → Run anyway* to proceed.

> The Android 1.0 app uses a new long-term release certificate. Remove any older debug-signed
> EZTerminal APK before installing 1.0; Android cannot update across the signing-key change and the
> uninstall removes that app's locally saved pairing data. Future releases signed with this key can
> update normally.

Windows and Android updates are manual. Verify the download against `SHA256SUMS.txt` in the release.
The mobile bridge binds only to a selected trusted VPN interface and uses plain `ws://` inside that
encrypted tunnel. Pairing grants the phone command/filesystem access and explicit visible desktop,
input, and text-clipboard control.

The supported targets remain Windows 10 22H2/Windows 11 x64 and Android 10+, while this
candidate's validation evidence is limited to the current Windows host and API
29/API 35 emulators. Elevated/admin service lifecycle and physical-device
validation were not performed. Certificate provisioning, store publication,
and automatic-update operations are outside this hardening change; see the
[1.0.4 validation policy](docs/release/validation-policy-1.0.4.md).

## Build from source

```bash
pnpm install
pnpm start        # run in development
pnpm make         # build the Windows installer -> out/make/nsis/x64/
pnpm test         # unit tests (Vitest)
pnpm e2e          # end-to-end tests (Playwright + Electron)
```

Graphical PC Control is included by default in Windows builds. At runtime it
still requires an enabled remote bridge, a running installed host service, and
a trusted VPN interface; otherwise the desktop capability is not advertised.
Secure-desktop and Ctrl+Alt+Delete support are not included in 1.0.4.

The Android companion app lives in [`mobile/`](mobile/) (Capacitor + Android Studio).

## Tech stack

Electron · React · TypeScript · xterm.js · node-pty (ConPTY) · Capacitor (Android) · Vite · Playwright

## Security

Remote control is opt-in and token-gated. See **[SECURITY.md](SECURITY.md)** for the remote-bridge
threat model and how to report a vulnerability.

## License

[MIT](LICENSE) © 2026 dlwlgus9125
