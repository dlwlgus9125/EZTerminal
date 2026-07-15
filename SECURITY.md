# Security Policy

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/dlwlgus9125/EZTerminal/security/advisories/new)
(or by opening a minimal issue asking for a private channel). Do not disclose
details publicly until a fix is available.

## Threat model — the mobile remote-control bridge

EZTerminal can expose an optional WebSocket bridge (`src/main/remote-bridge.ts`)
so the companion mobile app can drive terminal sessions on the desktop host.
**This is the most security-sensitive part of the app**, because a paired
client is, by design, a remote terminal:

> **Pairing a device grants it full command execution and full filesystem
> read/write access to this machine — everything the desktop user can do.**
> The file-browser API is intentionally not confined to a subfolder; the shell
> (`run-command`) already grants equivalent access, so the pairing token *is*
> host access. Treat the token like a password to your computer.

### What protects it

- **Off by default (opt-in).** The bridge does not listen until you enable
  remote control in **Settings**. A fresh install exposes nothing.
- **Token-gated.** Access requires a 256-bit token (`crypto.randomBytes(32)`),
  minted per install and stored under the app's `userData`. The token is
  compared in constant time (`timingSafeEqual`) and can be **rotated** from the
  pairing panel, which immediately invalidates any leaked copy.
- **Fail-closed credential storage.** The desktop token file is atomically
  replaced and verified as mode `0600` on POSIX. On Windows, Electron
  `safeStorage` encrypts the bearer token with OS-backed protection before any
  file write; a current-user + SYSTEM protected DACL remains defense in depth.
  Existing schema-v1 plaintext is replaced with ciphertext before the bridge
  can use it. Android saves paired credentials through
  AndroidKeyStore and does not fall back to plaintext/base64 preferences;
  legacy plaintext is deleted only after a secure read-back succeeds.
- **Origin-checked.** The server rejects browser cross-origin connections
  (Cross-Site WebSocket Hijacking / DNS-rebinding defense); only the mobile
  WebView origin and non-browser clients may connect.
- **Bounded.** Inbound frames are size-capped, concurrent connections are
  limited, and a socket that does not authenticate promptly is dropped.
  Unexpected disconnects retain at most 32 run ports for five minutes, drain
  output under backpressure, and require the same token before resuming. An
  explicit Disconnect releases those leases; an invalid token stops retries.

### What you must do

- **The transport is plain `ws://` (not encrypted).** Only enable the bridge on
  a network you trust, or reach the desktop over an **encrypted overlay such as
  [Tailscale](https://tailscale.com/) / WireGuard**, whose tunnel encrypts the
  traffic (including the token). On untrusted/shared Wi‑Fi, an on-path attacker
  could otherwise capture the token from the first `auth` frame.
- Disable remote control when you are not using it.
- **Update both applications together.** Desktop and Android 1.0 use an explicit
  remote-protocol version and reject incompatible peers instead of retrying as
  though the token were wrong. Updates are downloaded manually from GitHub
  Releases and verified with the published `SHA256SUMS.txt`.
- **Android 1.0 rekeys the app.** APKs published before 1.0 used a debug
  certificate. They must be uninstalled before the release-signed 1.0 APK can
  be installed, which also removes saved pairing data. Do not bypass Android's
  signature check or install APKs from unofficial mirrors.

### Known limitations / roadmap

- **No TLS yet.** `wss://` with a pinned self-signed certificate is planned so
  the bridge can be used safely on an untrusted LAN without an overlay. Until
  then, rely on Tailscale/WireGuard or a trusted network.

## Desktop application hardening

The Electron app follows current hardening guidance: `contextIsolation` and
`sandbox` on, `nodeIntegration` off, a narrow `contextBridge` surface (no raw
`ipcRenderer`), a strict Content-Security-Policy, navigation/window-open guards,
and Electron fuses (`RunAsNode`/inspector disabled, ASAR integrity). External
programs are spawned with argument arrays (never a shell string), and SSH host
keys are verified (TOFU) before any credential is sent.

After a risky-close confirmation, the interpreter atomically compares the
expected active run IDs and refuses the close if session state changed.
Terminal-originated OSC 52 clipboard writes are disabled by default, write-only,
strictly decoded and independently size/rate limited in renderer and main;
semantic attach replay renders OSC 52 without repeating clipboard side effects.
Terminal file links require an explicit action and a main-owned realpath
containment check, then preview through a short-lived one-shot file-identity
capability so a resolve/open race cannot substitute another file. OpenSSH
aliases are resolved from an inert allowlist and
applicable command/proxy/forward directives fail closed. Git worktree deletion
is restricted to clean, idle EZTerminal-owned worktrees without force, while
SSH local forwarding binds only to `127.0.0.1`, is resource-bounded, and is
torn down with its authenticated SSH connection.

Late-attach terminal restoration models PTY **output only** in a bounded
headless xterm instance; user input is never retained or replayed. Snapshot,
tail and pending-operation limits fall back to a bounded raw-output ring with
an explicit warning. SSH late attach is rejected until an equivalent safe
replay transport exists.
