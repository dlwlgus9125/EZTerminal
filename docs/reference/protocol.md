---
doc_type: reference
authority: canonical
status: active
---

# IPC Protocol

Typed IPC channels between main and renderer processes via contextBridge preload API.

## Transport

All cross-process communication uses Electron IPC through `contextBridge.exposeInMainWorld()`.

Three transport patterns:
- **invoke/handle** (request-response): `ipcMain.handle()` + `ipcRenderer.invoke()` — returns Promise. Used for commands requiring a response value.
- **send/on** (fire-and-forget R->M): `ipcRenderer.send()` + `ipcMain.on()` — no return. Used for unidirectional commands where response is unnecessary (e.g., keystrokes, lifecycle signals).
- **send/on** (push M->R): `webContents.send()` + `ipcRenderer.on()` — fire-and-forget to renderer. Used for streaming data (PTY output, metrics, network).

No direct `ipcRenderer` calls in renderer code (ASR-8). All access through preload `electronAPI`.

## PTY Channels (6)

| Channel | Direction | Type | Signature |
|---------|-----------|------|-----------|
| `pty:create` | renderer -> main | invoke/handle | `(shellPath?: string) => { sessionId: string }` |
| `pty:write` | renderer -> main | send/on | `(sessionId: string, data: string) => void` |
| `pty:resize` | renderer -> main | send/on | `(sessionId: string, cols: number, rows: number) => void` |
| `pty:kill` | renderer -> main | invoke/handle | `(sessionId: string) => void` |
| `pty:data:{id}` | main -> renderer | send/on | `(data: string) => void` |
| `pty:exit:{id}` | main -> renderer | send/on | `(exitCode: number) => void` |

`pty:write` and `pty:resize` use fire-and-forget send pattern for performance (ASR-1: key-to-pty <16ms). No Promise overhead on keystrokes.

`pty:data:{id}` and `pty:exit:{id}` use per-session channels (id = PTY session UUID). Each TerminalView subscribes only to its own session channels. Max 4 active sessions (max panes).

### Frame Coalescing Contract (ADR-003)

`pty:data:{id}` events are coalesced into 16ms frames:
1. PTY stdout callback fires -> data appended to session buffer
2. If no flush timer running for session -> start 16ms timer
3. On timer fire -> concatenate buffer -> single `pty:data:{id}` send -> clear buffer
4. Guarantees: max 62.5 events/sec per session, min latency ~16ms for non-empty buffer

## Metrics Channels (3)

| Channel | Direction | Type | Signature |
|---------|-----------|------|-----------|
| `metrics:start` | renderer -> main | send/on | `() => void` |
| `metrics:stop` | renderer -> main | send/on | `() => void` |
| `metrics:data` | main -> renderer | send/on | `(payload: MetricPayload) => void` |

`metrics:start` and `metrics:stop` use fire-and-forget send. No response needed; MetricsService handles dedupe internally. Lifecycle bound to panel visibility (ADR-006).

## Network Channels (8)

| Channel | Direction | Type | Signature |
|---------|-----------|------|-----------|
| `network:startTraffic` | renderer -> main | send/on | `(interfaceName?: string) => void` |
| `network:stopTraffic` | renderer -> main | send/on | `() => void` |
| `network:startCapture` | renderer -> main | invoke/handle | `(interfaceName: string) => void` |
| `network:stopCapture` | renderer -> main | invoke/handle | `() => void` |
| `network:getConnections` | renderer -> main | invoke/handle | `() => Connection[]` |
| `network:isNpcapAvailable` | renderer -> main | invoke/handle | `() => boolean` |
| `network:traffic` | main -> renderer | send/on | `(point: TrafficPoint) => void` |
| `network:packets` | main -> renderer | send/on | `(packets: Packet[]) => void` |

Traffic and capture are independent systems:
- **Traffic** (startTraffic/stopTraffic/traffic): Aggregate RX/TX statistics. Works without Npcap via systeminformation fallback. Fire-and-forget lifecycle control.
- **Capture** (startCapture/stopCapture/packets): Individual packet recording. Requires Npcap via cap library. Uses invoke for error propagation on cap.open() failure.
- **Connections** (getConnections): netstat-based via systeminformation. Independent of both traffic and capture.
- **Detection** (isNpcapAvailable): Returns cached boolean from stage 4 Npcap detection.

## Settings Channels (2)

| Channel | Direction | Type | Signature |
|---------|-----------|------|-----------|
| `settings:load` | renderer -> main | invoke/handle | `() => Settings` |
| `settings:save` | renderer -> main | invoke/handle | `(settings: Settings) => void` |

`settings:save` uses atomic write (.tmp -> rename). On load failure (corrupt file), returns hardcoded defaults.

## Window Channels (4)

| Channel | Direction | Type | Signature |
|---------|-----------|------|-----------|
| `window:minimize` | renderer -> main | send/on | `() => void` |
| `window:maximize` | renderer -> main | send/on | `() => void` |
| `window:close` | renderer -> main | send/on | `() => void` |
| `window:isMaximized` | renderer -> main | invoke/handle | `() => boolean` |

Window control commands use fire-and-forget send (no response needed for minimize/maximize/close).

## Error Propagation

- **invoke/handle** errors: Handler throws -> renderer `invoke()` rejects with error message. Renderer must catch and display user-facing errors.
- **send/on** (R->M) errors: Main process logs error. No propagation to renderer. Errors manifest via absence of expected push events or via separate error events.
- **send/on** (M->R) push events: No error channel. Errors logged in main, last valid value retained in renderer.

## Channel Summary

| Pattern | Count | Channels |
|---------|-------|----------|
| invoke/handle | 9 | pty:create, pty:kill, settings:load, settings:save, window:isMaximized, network:startCapture, network:stopCapture, network:getConnections, network:isNpcapAvailable |
| send (R->M) | 9 | pty:write, pty:resize, metrics:start, metrics:stop, network:startTraffic, network:stopTraffic, window:minimize, window:maximize, window:close |
| send (M->R) | 5+N | pty:data:{id}, pty:exit:{id}, metrics:data, network:traffic, network:packets |
| **Total** | **23+N** | N = active PTY sessions (max 4, so max 8 per-session channels) |
