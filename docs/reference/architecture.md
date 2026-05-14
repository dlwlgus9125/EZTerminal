---
doc_type: reference
authority: canonical
status: active
---

# Architecture

## Three-Layer Model

```
┌─────────────────────────────────────────────┐
│  renderer (React 19, Zustand, xterm.js)     │
│  - No Node.js, no electron imports          │
│  - Communicates only via window.electronAPI  │
├─────────────────────────────────────────────┤
│  preload (contextBridge)                     │
│  - Typed API surface                        │
│  - Maps ipcRenderer.invoke → typed methods  │
├─────────────────────────────────────────────┤
│  main (Node.js)                              │
│  - node-pty, systeminformation, cap          │
│  - IPC handlers, settings, window manager   │
└─────────────────────────────────────────────┘
```

## Module Boundaries

| Module | Responsibility | Public Interface |
|--------|---------------|-----------------|
| main/pty | PTY session CRUD, 16ms frame coalescing | PtyManager: create/write/resize/kill |
| main/ipc | IPC channel registration and routing | Channel handlers for pty:*, metrics:*, network:*, settings:* |
| main/metrics | System metric collection (systeminformation) | MetricsService: start/stop/getData |
| main/network | Traffic + packet capture (cap/systeminformation) | NetworkService: startCapture/stop/getTraffic/getConnections |
| main/settings | Atomic JSON persistence | SettingsService: load/save/getDefaults |
| main/window | BrowserWindow lifecycle | WindowManager: createMain/createFloating/broadcast |
| preload/api | contextBridge typed surface | ElectronAPI interface |
| renderer/stores | Zustand slices (tab, settings, metrics, network, ui) | Per-slice selectors and actions |
| renderer/terminal | xterm.js wrapper with addon management | TerminalView: mount/write/resize/dispose |
| renderer/components | React UI tree | Props-driven components |

## Allowed Dependencies

```
main/pty       → node-pty
main/metrics   → systeminformation
main/network   → cap, systeminformation
main/settings  → fs (Node.js)
main/ipc       → main/pty, main/metrics, main/network, main/settings, main/window
main/window    → electron
preload/api    → electron (contextBridge, ipcRenderer)
renderer/*     → preload/api (via window.electronAPI)
renderer/terminal → xterm.js, @xterm/addon-*
renderer/stores   → zustand
renderer/components → renderer/stores, renderer/terminal
```

## Forbidden Dependencies

- **renderer → Node.js**: No fs, path, child_process, node-pty imports
- **renderer → electron**: No ipcRenderer.send/invoke directly (only via preload API)
- **main → React/xterm.js/Zustand**: Main process has no UI framework
- **preload → main modules**: Only ipcRenderer, not direct module imports

## Data Ownership

| Data | Owner | Access Pattern |
|------|-------|---------------|
| PTY sessions | main/pty | renderer reads via IPC events |
| Tab/pane layout | renderer/stores (tabSlice) | main unaware of UI state |
| Settings | main/settings (file) | renderer reads/writes via IPC |
| System metrics | main/metrics | renderer subscribes via IPC |
| Network data | main/network | renderer subscribes via IPC |
| Terminal buffer | xterm.js (renderer) | main unaware of buffer content |

## Key Architectural Decisions

- ADR-001: Electron 3-layer + typed IPC
- ADR-002: xterm.js full delegation (no custom VT parser)
- ADR-003: 16ms PTY data frame coalescing
- ADR-004: Custom SplitContainer (CSS Grid recursive)
- ADR-005: Persist xterm.js instances via display:none
- ADR-006: Visibility lifecycle pattern for collectors
- ADR-007: Npcap graceful degradation

## Lifecycle Stage

Production — feature spec verified in previous C# implementation, stack migration only.

## Compatibility Policy

semver after v1.0. Settings JSON versioned with migration functions per version bump.
