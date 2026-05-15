---
doc_type: reference
authority: canonical
status: active
---

# IPC Protocol

Typed IPC channels between main and renderer processes via contextBridge preload API.

## Transport

All cross-process communication uses Electron IPC through `contextBridge.exposeInMainWorld()`.
- Request/response: `ipcMain.handle()` + `ipcRenderer.invoke()` — returns Promise
- Push events: `webContents.send()` + `ipcRenderer.on()` — fire-and-forget to renderer
- No direct `ipcRenderer.send()` in renderer code (enforced by ASR-8)

## PTY Channels (5)

| Channel | Direction | Type | Signature |
|---------|-----------|------|-----------|
| `pty:create` | renderer → main | invoke/handle | `(shellPath?: string) => { sessionId: string }` |
| `pty:write` | renderer → main | invoke/handle | `(sessionId: string, data: string) => void` |
| `pty:resize` | renderer → main | invoke/handle | `(sessionId: string, cols: number, rows: number) => void` |
| `pty:data` | main → renderer | send/on | `(sessionId: string, data: string) => void` |
| `pty:exit` | main → renderer | send/on | `(sessionId: string, exitCode: number) => void` |

### Frame Coalescing Contract (ADR-003)

`pty:data` events are coalesced into 16ms frames:
1. PTY stdout callback fires → data appended to buffer
2. If no flush timer running → start 16ms timer
3. On timer fire → concatenate buffer → single `pty:data` send → clear buffer
4. Guarantees: max 62.5 events/sec per session, min latency ~16ms for non-empty buffer

## Metrics Channels (3)

| Channel | Direction | Type | Signature |
|---------|-----------|------|-----------|
| `metrics:start` | renderer → main | invoke/handle | `() => void` |
| `metrics:stop` | renderer → main | invoke/handle | `() => void` |
| `metrics:data` | main → renderer | send/on | `(payload: MetricPayload) => void` |

Lifecycle: `metrics:start` begins interval collection, `metrics:stop` clears intervals. Bound to panel visibility (ADR-006).

## Network Channels (5)

| Channel | Direction | Type | Signature |
|---------|-----------|------|-----------|
| `network:startCapture` | renderer → main | invoke/handle | `(interfaceName: string) => void` |
| `network:stopCapture` | renderer → main | invoke/handle | `() => void` |
| `network:getConnections` | renderer → main | invoke/handle | `() => Connection[]` |
| `network:traffic` | main → renderer | send/on | `(point: TrafficPoint) => void` |
| `network:packets` | main → renderer | send/on | `(packets: Packet[]) => void` |

`network:startCapture` requires Npcap. If unavailable, returns error. Traffic and connections work without Npcap (systeminformation/netstat fallback).

## Settings Channels (2)

| Channel | Direction | Type | Signature |
|---------|-----------|------|-----------|
| `settings:load` | renderer → main | invoke/handle | `() => Settings` |
| `settings:save` | renderer → main | invoke/handle | `(settings: Settings) => void` |

`settings:save` uses atomic write (.tmp → rename). On load failure (corrupt file), returns hardcoded defaults.

## Error Propagation

All `ipcMain.handle()` errors propagate as rejected Promises to renderer:
- Handler throws → renderer `invoke()` rejects with error message
- Renderer must catch and display user-facing errors
- Push events (`send/on`) have no error channel — errors are logged in main, last valid value retained in renderer
