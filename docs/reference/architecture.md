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
| main/network | Traffic + packet capture (cap/systeminformation) | NetworkService: startTraffic/stopTraffic/startCapture/stopCapture/getConnections/isNpcapAvailable |
| main/settings | Atomic JSON persistence | SettingsService: load/save/getDefaults |
| main/window | BrowserWindow lifecycle | WindowManager: createMain/createFloating/broadcast |
| preload/api | contextBridge typed surface | ElectronAPI interface |
| renderer/stores | Zustand slices (tab, settings, metrics, network, ui) | Per-slice selectors and actions |
| renderer/terminal | xterm.js wrapper with addon management | TerminalView: mount/write/resize/dispose |
| main/filesystem | CWD readdir, file stat, text preview read, CWD query | FilesystemService: readDir/readPreview/getCwd |
| main/scrollback | Save dialog + scrollback text write | ScrollbackService: saveScrollback |
| main/protocol | ezterm-file:// custom protocol registration | registerFileProtocol at app ready |
| renderer/stores (filesSlice) | File tree state, selected file, preview, CWD | filesSlice: tree, selectedPath, previewData, cwdPath |
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
renderer/components → renderer/stores, renderer/terminal, @tanstack/react-virtual
main/filesystem  → fs, path (Node.js), chokidar 4.x
main/scrollback  → electron (dialog), fs
main/protocol    → electron (protocol), fs, path
main/ipc         → main/filesystem, main/scrollback (addition to existing)
renderer/terminal → @xterm/addon-serialize (addition)
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
| File tree | main/filesystem (computed) | renderer requests via IPC, caches in filesSlice |
| File preview | main/filesystem (text) / renderer (image/HTML via protocol) | text: IPC response. image/HTML: ezterm-file:// direct load |
| CWD per session | main/filesystem (Win32 fallback) / renderer (OSC 7) | OSC 7 updates filesSlice directly; fallback queries main |
| Scrollback text | renderer (xterm.js SerializeAddon) | serialized in renderer, sent to main for file write |

## Key Architectural Decisions

- ADR-001: Electron 3-layer + typed IPC
- ADR-002: xterm.js full delegation (no custom VT parser)
- ADR-003: 16ms PTY data frame coalescing
- ADR-004: Custom SplitContainer (CSS Grid recursive)
- ADR-005: Persist xterm.js instances via display:none
- ADR-006: Visibility lifecycle pattern for collectors
- ADR-007: Npcap graceful degradation
- ADR-008: OSC 7 CWD detection + Win32 API fallback
- ADR-009: Custom file protocol (ezterm-file://) for image/HTML preview

## Lifecycle Stage

Production — feature spec verified in previous C# implementation, stack migration only.

## Compatibility Policy

semver after v1.0. Settings JSON versioned with migration functions per version bump.
