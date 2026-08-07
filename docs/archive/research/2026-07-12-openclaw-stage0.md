# OpenClaw Stage-0 Discovery Spike (M0)

Date: 2026-07-12
Branch: `feat/openclaw-management`
Environment: OpenClaw 2026.6.11 (e085fa1), npm global install, gateway running as Windows scheduled task "OpenClaw Gateway" on `127.0.0.1:18789`. Windows 10, PowerShell + Git Bash.

Goal: resolve every unverified assumption in the approved plan (`jiggly-wobbling-kahn.md`) before product code lands. All probes below are read-only against the live gateway except the isolated `--profile m0spike` config round-trip, which never touched the live config file.

---

## ① `config get/set/validate` framing

**`config get <path>` (plain mode):** prints the raw value with a trailing newline, exit 0. No quoting for strings.

**`config get <path> --json`:** prints a JSON-encoded value (e.g. a string is wrapped in double quotes), exit 0.

**Missing path** (schema-valid but not present in `openclaw.json`, e.g. `gateway.port` — it is optional and unset in this install): both plain and `--json` modes print `Config path not found: <path>. Run openclaw config validate to inspect config shape.` and exit **1**. This is true even for paths the JSON schema declares (confirmed via `openclaw config schema`) — `config get` only reflects what is actually written to the file, never a computed/effective/default value. **M1 implication:** `getCoreConfig()` must treat "not found" (exit 1 + that message) as "unset", not as an error, for every allowlisted field — the gateway currently resolves `gateway.port` from the scheduled-task's `--port 18789` CLI arg / `OPENCLAW_GATEWAY_PORT` env var, not from the config file.

**Token redaction — critical, refutes a plan assumption:** `openclaw config get gateway.auth.token` (plain and `--json`) prints the literal sentinel string `__OPENCLAW_REDACTED__`, never the real token. (That sentinel is the CLI's own placeholder, not a secret — safe to record verbatim.) This also holds for `config get gateway --json` (parent-object fetch): the nested `auth.token` field is redacted the same way. **The CLI can never be used to retrieve the real token — only the direct config file read (`~/.openclaw/openclaw.json`, path confirmed via `openclaw config file` → `~\.openclaw\openclaw.json`) works.** The plan already listed the file read as a fallback source ("토큰 소스: `config get` 또는 `~/.openclaw/openclaw.json`") — Stage-0 confirms it is the **only** viable source, not an alternative. `openclaw config file` has no `--json` flag (untested whether one exists; `--help` doesn't list it, plain text path only).

**`agents.defaults.model` (a normal, non-secret path):** returns cleanly, e.g. plain → `openai/gpt-5.5`, `--json` → `"openai/gpt-5.5"`. Confirms `config get` framing is otherwise exactly as assumed for non-redacted fields.

**`config set` + `config validate` round-trip, isolated via `--profile m0spike`:**
- `openclaw --profile m0spike config set gateway.port 19099 --strict-json` → `Updated gateway.port. Restart the gateway to apply.`, exit 0. Created `~/.openclaw-m0spike/{openclaw.json,logs/,state/}` — **did not touch** `~/.openclaw/openclaw.json`.
- `openclaw --profile m0spike config get gateway.port --json` → `19099` (round-tripped correctly).
- `openclaw --profile m0spike config validate --json` → `{"valid":true,"path":"C:\\Users\\dlwlg\\.openclaw-m0spike\\openclaw.json","warnings":[]}`.
- Re-ran `openclaw config get gateway.port` (no profile) afterward → still "Config path not found" — **live config confirmed untouched**.
- Scratch profile directory (`~/.openclaw-m0spike`) deleted after the test.

`config set` on a real value shows the exact same "Updated <path>. Restart the gateway to apply." pattern — useful copy for a settings-saved toast, and confirms a restart is required to take effect (matches AC4's "설정 반영" needing to be paired with a restart nudge, not silent live-reload).

**Verdict: CONFIRMED, with one refutation.** Get/set/validate framing works as planned for normal fields. The token-via-CLI assumption is **REFUTED** — `gateway.auth.token` is unconditionally redacted by the CLI at every access path tried; M1's `getChatToken()`/`getChatUrl()` must read `~/.openclaw/openclaw.json` directly (already the plan's designated fallback, now mandatory).

---

## ② WebContentsView spike

Script: throwaway `wcv-spike.js` (scratchpad), run via `pnpm exec electron`. Created a `BrowserWindow` + `WebContentsView` with `partition: 'persist:openclaw-chat-spike'`, `sandbox: true`, `contextIsolation: true`, no preload, loaded `http://127.0.0.1:18789/#token=<token from ~/.openclaw/openclaw.json>`.

**(a) Control UI renders:** `did-finish-load` fired; `webContents.getTitle()` → `"OpenClaw Control"`. Screenshot confirms a fully-rendered Control UI (sidebar nav, top bar, chat transcript, message composer) — visually verified, not just DOM-probed.

**(b) WS connects / auth handoff works:** after load, the page URL was `http://127.0.0.1:18789/chat?session=main` — the SPA consumed the `#token=` fragment, authenticated, and client-side-routed to the chat view (no auth error screen, no login prompt). `document.body.innerText` showed the real session history ("Main Session", prior test messages), proving the WS connection authenticated successfully against the live gateway.

**(c) Live chat round-trip — went beyond "if feasible," fully succeeded:** DOM probe found exactly one `<textarea placeholder="Message Assistant (Enter to send)">`. Set its value via the native `HTMLTextAreaElement.prototype.value` setter + `input` event (bypasses React/Lit-controlled-input pitfalls), then sent a real Enter keypress via `webContents.sendInputEvent`. The gateway processed the message and the model replied **"pong"** to **"ping — reply with pong only"**, visible in the transcript and captured in a screenshot (`wcv-chat-roundtrip.png`, viewed and visually verified — composer, transcript bubbles, and the pong reply all render correctly with no visual artifacts from the sandboxed/no-preload configuration). This is a genuine live round-trip through the real `openai/gpt-5.5` backend, not a stub.

**Gateway-unreachable behavior:** a second `WebContentsView` (separate partition) loaded `http://127.0.0.1:18790/#token=...` (dead port, real gateway on 18789 was never touched). `did-fail-load` fired with `errorCode: -102` (`ERR_CONNECTION_REFUSED`) within ~1s. `webContents.getTitle()` fell back to the raw URL (Chromium's default when no document ever loads) — no crash, no hang. `capturePage()` on this failed-load view threw `ERR:UnknownVizError` (a transient Chromium compositor issue on a view that never painted content) — non-blocking, since the load-failure event itself is the actionable signal, not a screenshot of a blank page.

**M3 implication:** `did-fail-load` (and its error code) is the deterministic signal `OpenClawChatViewManager` should use to show a "reconnect" placeholder instead of a blank/frozen view.

**Verdict: CONFIRMED, exceeds scope.** WebContentsView with `sandbox:true / contextIsolation:true / no preload` fully renders and authenticates the Control UI, and a scripted chat round-trip works end-to-end against the live gateway on the first attempt. No fallback (`shell.openExternal`) is needed. Chat-input automation for M3's e2e suite has a known, single, stable selector (`textarea[placeholder="Message Assistant (Enter to send)"]`).

---

## ③ Reverse proxy spike

Script: throwaway `proxy-spike.js` (scratchpad), plain `node:http` + `net` (no framework), run via `node`. Listened on `127.0.0.1:7421`, forwarded HTTP via `http.request` (rewriting `Host` to `127.0.0.1:18789`) and piped `upgrade` events as a raw socket-to-socket splice (manually re-serialized the request line + headers with `Host` rewritten, wrote it into a fresh `net.connect` to the target, then bidirectionally piped bytes — no `http-proxy` dependency).

**Control baseline (direct fetch to :18789, no proxy):** `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'` (all other directives present: `default-src 'self'`, `script-src` with sha256 hashes, `connect-src 'self' ws: wss: https://api.openai.com https://tweakcn.com`, etc.) — confirms the plan's stated anti-embed headers exactly.

**Through the proxy:**
- `GET /` (no Origin header) → **200**, body = Control UI HTML (10316 bytes, `<title>OpenClaw Control</title>` present), `X-Frame-Options` **absent** (successfully stripped), CSP present with **only** `frame-ancestors` rewritten to `'self' http://127.0.0.1:7421` — every other directive (`script-src` hashes, `connect-src`, `style-src`, etc.) passed through byte-identical to the control baseline, confirming the "rewrite only frame-ancestors" requirement is achievable with a simple split-on-`;`-and-replace-one-directive approach.
- `GET /` with `Origin: http://localhost` → identical 200 response, headers unchanged. The gateway does not vary its HTTP response based on Origin.
- WS upgrade through the proxy, no Origin header → client `ws` library reports `open` (successful 101 Switching Protocols handshake spliced through the raw socket pipe).
- WS upgrade through the proxy, `Origin: http://localhost` → also `open`. **The gateway does not reject the WS upgrade based on Origin at the transport layer** (this install is `bind: loopback`, `auth.mode: token`) — Origin/CSWSH enforcement, if any, must happen at the application/RPC-auth layer (token in `connect.params.auth.token`), not at the HTTP Upgrade handshake. `verifyClient`-style Origin gating is therefore **not** a requirement for the proxy to pass WS traffic; the plan's ticket+cookie auth model remains the right control point for actually authorizing use, independent of this.

**Verdict: CONFIRMED.** A minimal raw-socket proxy (no dependency beyond Node core) achieves exactly the three required rewrites (Host on the way out, drop XFO, rewrite only `frame-ancestors`) and passes both HTTP and WS traffic including the upgrade handshake. No gateway-side Origin rejection was observed to design around.

---

## ④ RPC surface

`openclaw gateway call --help` **only** advertises `health/status/system-presence/cron.*` as its example method names in the CLI help text — this is what the plan flagged as the sole documented surface and gated on Stage-0.

**Refuted by the actual protocol docs.** Fetched `https://docs.openclaw.ai/gateway/protocol` and cross-verified with a raw HTML grep (not just the AI-summarized fetch, to guard against the "don't invent method names" risk) — the doc page's rendered body genuinely contains, verbatim (backtick-quoted in the source markdown):

- **Chat (legacy client API, still current):** `chat.history`, `chat.send`, `chat.abort`, `chat.inject`. Doc text: *"...still uses `chat.history`, `chat.send`, `chat.abort`, and `chat.inject`."* `chat.send` accepts a one-turn `fastMode: "auto"` param with a configurable `fastAutoOnSeconds` cutoff (default 60s).
- **Sessions:** `sessions.list`, `sessions.subscribe`, `sessions.unsubscribe`, `sessions.messages.subscribe/unsubscribe`, `sessions.preview`, `sessions.describe`, `sessions.resolve`, `sessions.create`, `sessions.groups.*`, `sessions.send`, `sessions.steer`, `sessions.abort`, `sessions.patch`, `sessions.reset`, `sessions.delete`, `sessions.compact`, `sessions.get`, `sessions.changed`, `sessions.usage`, `sessions.usage.timeseries`, `sessions.usage.logs`.
- **Cron (matches CLI help):** `cron.get`, `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`, `cron.run`, `cron.runs`.
- The doc explicitly states the discovery list surfaced in the `hello-ok` handshake (`hello-ok.features.methods`) is *"a conservative discovery list built from `src/gateway/server-methods-list.ts` plus loaded plugin/channel method exports — it is not a generated dump of every method"* and names `push.test`, `web.login.start`, `web.login.wait`, `sessions.usage` as examples of real, callable methods that are **intentionally excluded from discovery**. So the CLI help text (and even the handshake's own feature-discovery list) understates the real surface — neither should be treated as the authoritative allowlist.

`https://docs.openclaw.ai/web/control-ui` confirms the Control UI itself authenticates via `connect.params.auth.token` (or `.password`), and documents the `#token=` fragment as the **recommended** dev/remote handoff mechanism specifically *because* "fragments are not sent to the server, which avoids request-log and Referer leakage" — directly validating architecture decision (d).

**Note on methodology:** an initial cross-check via `curl` + a double-quote-delimited grep pattern falsely suggested `chat.*`/`sessions.*` were absent from the raw page — that was a grep pattern bug (the docs use backtick code-spans, not double-quoted strings), not an actual absence. Corrected the pattern and found every method name the AI-summarized fetch had reported, verbatim, in the raw HTML. Recorded here as a caution for future doc-scraping: verify with a raw-text grep using the actual markup convention, not an assumed one, before trusting or distrusting an AI-summarized fetch.

**Verdict: PARTIAL → resolved with a plan delta.** The RPC surface is real, documented, and far larger than `health/status/system-presence/cron.*`. Direct WS RPC (`chat.send`/`sessions.*`) is a viable, documented alternative to CLI-shelling for both chat and session data — see the latency finding in ⑥, which makes this more than a "nice to have."

---

## ⑤ `gateway install --help` + `gateway status --json --no-probe` shape

**`gateway install --help` flags:** `--force` (reinstall/overwrite), `--json`, `--port <port>`, `--runtime <node|bun>` (default node), `--token <token>`, `--wrapper <path>`. All the fields needed for an autostart-toggle confirmation dialog (port, runtime, token) are present as flags; no interactive-only gate.

**`gateway status --json --no-probe` shape** (sanitized — no token present in this output; nothing to redact):

```json
{
  "cli": { "version": "2026.6.11", "entrypoint": "...\\openclaw.mjs" },
  "logFile": "...\\openclaw-2026-07-12.log",
  "service": {
    "label": "Scheduled Task",
    "loaded": true,
    "loadedText": "registered",
    "notLoadedText": "missing",
    "command": {
      "programArguments": ["...\\node.exe", "...\\index.js", "gateway", "--port", "18789"],
      "environment": { "OPENCLAW_GATEWAY_PORT": "18789" },
      "sourcePath": "...\\gateway.cmd"
    },
    "runtime": { "status": "running", "pid": 2772, "detail": "Verified gateway listener detected on port 18789 even though schtasks did not report a running task." },
    "configAudit": { "ok": true, "issues": [] }
  },
  "config": {
    "cli": { "path": "...\\openclaw.json", "exists": true, "valid": true },
    "daemon": { "path": "...\\openclaw.json", "exists": true, "valid": true }
  },
  "gateway": { "bindMode": "loopback", "bindHost": "127.0.0.1", "port": 18789, "portSource": "service args", "probeUrl": "ws://127.0.0.1:18789", "probeNote": "Loopback-only gateway; only local clients can connect." },
  "port": { "port": 18789, "status": "busy", "listeners": [{ "pid": 2772, "address": "127.0.0.1:18789", "commandLine": "..." }], "hints": [] },
  "extraServices": [],
  "pluginVersionDrift": { "gatewayVersion": "2026.6.11", "drifts": [] }
}
```

Fields M1's `getStatus()` needs: `service.runtime.status` (`"running"` etc. — maps to `OpenClawStatus`), `service.runtime.pid`, `service.loaded`, `gateway.port` + `gateway.bindMode`, `cli.version`. Note `service.runtime.detail` shows the CLI already handles the "scheduled task reports not-running but a listener is actually up" edge case itself (worth trusting rather than re-deriving).

**Verdict: CONFIRMED.**

---

## ⑥ Latency — refutes the plan's polling-constant assumption

`Measure-Command`, 3 runs each, gateway left completely undisturbed throughout:

| Command | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| `openclaw gateway status --json --no-probe` | 10032 ms | 9165 ms | 9059 ms |
| `openclaw status --json` | 17610 ms | 17852 ms | 18601 ms |
| Plain `HTTP GET /` (Node `http.get`, no CLI) | 107 ms | 23 ms | 24 ms |

The plan's Risk #6 assumed "CLI 기동 0.5–1초" (~0.5-1s CLI startup) and recommended "HTTP 생존 프로브 위주, CLI는 엣지에서만" (prefer HTTP liveness probing, use CLI only at edges). **The real cost is 9-10 seconds for even the `--no-probe` status call, and 17.5-18.6 seconds for `status --json`** (which additionally does a live RPC round-trip for `sessions.recent[]`) — 10-20x worse than assumed. This is consistent across all 3 runs each (not a one-time cold-start blip), so it reads as the structural Node.js process-bootstrap + eager-subcommand-loading cost of this specific CLI (it registers dozens of top-level command groups — `acp`, `agents`, `backup`, `capability`, `channels`, `mcp`, `sandbox`, `talk`, etc. — and appears to load them eagerly rather than lazily), not a fluke of this machine's disk cache.

Plain HTTP GET of the Control UI's static page is fast (23-107ms) but only fetches the static HTML shell, not status/session/log data — it cannot substitute for a status call as-is.

**Verdict: REFUTED — this is the highest-impact finding of Stage-0.** A CLI shell-out is unusable for *any* interactively-triggered status/session refresh (opening the drawer, polling while it's open, post-lifecycle-action confirmation) — a 9-18 second spinner on every open is not acceptable UX and directly threatens AC1/AC3/AC6. See Plan Deltas below for the required M1 change.

---

## Plan deltas

1. **M1 must not use the CLI for status/session polling.** Given ⑥, `openclaw-service.ts`'s `getStatus()` / `listAgentSessions()` / `subscribeStatus()` must talk **directly to the gateway over WS RPC** (`health`, `status`, `sessions.list`, `sessions.usage` — all confirmed real and documented per ④) using the token read from `~/.openclaw/openclaw.json` (per ①), not `child_process.spawn('openclaw', ['status', '--json'])`. Reserve CLI spawning for genuinely infrequent, user-initiated actions where a multi-second wait is expected and already has a "busy" affordance in the plan: `gateway start/stop/restart/install`, and cold "is openclaw installed at all" detection. This pulls forward architecture decision (c)'s deferred "직접 WS RPC는... 후속 최적화로 보류" — Stage-0's evidence means it can no longer be deferred; it's required for M1 to meet AC1/AC3/AC6 at all. `subscribeStatus`/`subscribeLogs` in the module list already anticipated a subscription-shaped API, which maps naturally onto `sessions.subscribe`/`logs.tail` RPC methods instead of a poll-the-CLI-on-a-timer loop.
2. **Token retrieval is CLI-proof, not CLI-first.** `getChatToken()`/`getChatUrl()` must read `~/.openclaw/openclaw.json` directly (confirmed the only path that returns the real token — CLI always returns the `__OPENCLAW_REDACTED__` sentinel, at every access pattern tried including parent-object fetches). `openclaw config file` (no flags) gives the resolvable path portably; DI env override `EZTERMINAL_OPENCLAW_CLI`/`EZTERMINAL_OPENCLAW_URL` should get a sibling for the config-file path in CI (fake gateway fixture has no real `~/.openclaw/openclaw.json`).
3. **`config get` "not found" (exit 1) is the unset signal, not an error path**, for every allowlisted core-config field — `getCoreConfig()` needs an explicit unset/absent state distinct from a real error (CLI-not-installed, gateway down), since `gateway.port` itself is unset-by-default in a real install (resolved from the scheduled task's `--port` arg instead).
4. **`config set` requires a restart to take effect** ("Updated <path>. Restart the gateway to apply.") — M2's settings form should surface this explicitly (toast/banner: "Restart the gateway to apply"), not imply live reload.
5. **The WebContentsView chat embed needs no fallback.** Drop any residual `shell.openExternal` fallback planning for M3 — the primary path works end-to-end, including a real model round-trip, on the first spike attempt with the exact `sandbox:true/contextIsolation:true/no-preload` configuration the architecture decision specified. `did-fail-load` (errorCode `-102` for connection-refused) is the concrete signal for the "gateway unreachable" placeholder state.
6. **The reverse proxy's three required rewrites are all confirmed sufficient** — no additional Origin-allowlisting logic is needed at the HTTP/WS-upgrade layer for M4/M5; the gateway does not reject on Origin at that layer for a loopback/token-auth install. Ticket+cookie auth remains the correct control point (unchanged from the plan).
7. Chat-input automation for M3 e2e has one stable selector: `textarea[placeholder="Message Assistant (Enter to send)"]`, `Enter` submits (no separate send-button click needed, though `button.agent-chat__input-btn` exists as an alternative if the textarea approach proves flaky in headless e2e).

---

## Scratch artifacts (not committed)

All spike scripts and screenshots live in the session scratchpad, not the repo:
- `wcv-spike.js`, `wcv-real-gateway.png`, `wcv-chat-roundtrip.png`, `wcv-spike-results.json`
- `proxy-spike.js`
- `openclaw-schema.json`, `gw-protocol.html` (raw docs page, used for the ④ cross-check)

No token value appears in this document or in git history for this branch.
