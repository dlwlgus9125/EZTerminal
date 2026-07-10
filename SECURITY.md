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
- **Origin-checked.** The server rejects browser cross-origin connections
  (Cross-Site WebSocket Hijacking / DNS-rebinding defense); only the mobile
  WebView origin and non-browser clients may connect.
- **Bounded.** Inbound frames are size-capped, concurrent connections are
  limited, and a socket that does not authenticate promptly is dropped.

### What you must do

- **The transport is plain `ws://` (not encrypted).** Only enable the bridge on
  a network you trust, or reach the desktop over an **encrypted overlay such as
  [Tailscale](https://tailscale.com/) / WireGuard**, whose tunnel encrypts the
  traffic (including the token). On untrusted/shared Wi‑Fi, an on-path attacker
  could otherwise capture the token from the first `auth` frame.
- Disable remote control when you are not using it.

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
