# ADR-009: Custom File Protocol for Preview

## Status
Accepted

## Context
Files panel needs to display image and HTML previews in the renderer process. Electron's renderer is sandboxed (ASR-8: no Node.js access). Two options exist for serving local files to renderer: (A) base64-encode file content and send via IPC, or (B) register a custom Electron protocol that serves files directly.

Forces:
- A 5MB image base64-encoded becomes ~6.7MB, transmitted through Electron's IPC structured clone which blocks the main process event loop
- ASR-1 requires key-to-PTY latency <16ms; blocking main event loop risks violating this
- HTML preview needs to load CSS/images referenced within the HTML document
- Security: renderer must not gain arbitrary filesystem read access

## Decision
Register `ezterm-file://` custom protocol via `protocol.handle()` at app startup. The protocol handler validates requests against an extension whitelist (image: .png/.jpg/.jpeg/.gif/.bmp/.webp/.svg; HTML: .html/.htm), resolves symlinks, checks for path traversal, and serves file content with correct MIME types. Non-whitelisted extensions receive 403. Renderer loads images via `<img src="ezterm-file://...">` and HTML via `<iframe sandbox="allow-same-origin" src="ezterm-file://...">`.

## Consequences
- Positive: Zero IPC overhead for image/HTML preview; main event loop unblocked
- Positive: HTML preview can load relative CSS/image resources via same protocol
- Positive: Extension whitelist + path traversal validation maintains security boundary
- Negative: Custom protocol is app-level registration, harder to reason about than simple IPC
- Negative: iframe sandbox allows same-origin but blocks scripts — CSS-only attacks (e.g., CSS exfiltration) are theoretically possible but irrelevant for local file preview
- Follow-up review trigger: If Electron deprecates protocol.handle() API, migrate to successor
