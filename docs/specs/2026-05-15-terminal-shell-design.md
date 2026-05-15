---
doc_type: spec
authority: derived
status: approved
id: spec-1
date: 2026-05-15
---

# Terminal Shell Design

Electron-based terminal emulator: project structure, PTY management, xterm.js rendering, multi-tab/split, desktop UX, app lifecycle.

## Architecture Baseline

**Selected approach:** Electron 3-layer (main/preload/renderer) with typed IPC via contextBridge (ADR-001). React 19 + Zustand 5 renderer, xterm.js 5 full delegation (ADR-002), node-pty 1.0 with 16ms frame coalescing (ADR-003).

**Modules:**
| Module | Responsibility | Public Interface |
|--------|---------------|------------------|
| main/pty | PTY CRUD, 16ms coalescing | PtyManager: create/write/resize/kill/killAll |
| main/ipc | Channel registration | Handlers for pty:\*/metrics:\*/network:\*/settings:\* |
| main/metrics | systeminformation collection | MetricsService: start/stop/getData |
| main/network | Traffic + packet capture | NetworkService: startTraffic/stop/startCapture/stop/getConnections/isNpcapAvailable |
| main/settings | Atomic JSON persistence | SettingsService: load/save/getDefaults |
| main/window | BrowserWindow lifecycle | WindowManager: createMain/createFloating/broadcast |
| preload/api | contextBridge typed surface | ElectronAPI interface |
| renderer/stores | Zustand slices (5) | Selectors/actions per slice |
| renderer/terminal | xterm.js wrapper | TerminalView: mount/write/resize/dispose |
| renderer/components | React UI tree | Props-driven components |

**Allowed dependencies:** main/pty -> node-pty; main/metrics -> systeminformation; main/network -> cap, systeminformation; main/settings -> fs; main/ipc -> main/\* modules, main/window; main/window -> electron; preload/api -> electron (contextBridge, ipcRenderer); renderer/\* -> preload/api (via window.electronAPI); renderer/terminal -> xterm.js, @xterm/addon-\*; renderer/stores -> zustand; renderer/components -> renderer/stores, renderer/terminal.

**Forbidden dependencies:** renderer -> Node.js (fs, path, child_process, node-pty); renderer -> electron (no ipcRenderer direct); main -> React/xterm.js/Zustand; preload -> main modules directly.

**Data ownership:** PTY sessions owned by main/pty; tab/pane layout by renderer/stores (tabSlice); settings by main/settings (file); system metrics by main/metrics; network data by main/network; terminal buffer by xterm.js (renderer).

**IPC transport patterns:**
- `invoke/handle` (request-response): pty:create, pty:kill, settings:load, settings:save, window:isMaximized, network:startCapture, network:stopCapture, network:getConnections, network:isNpcapAvailable
- `send` (R->M fire-and-forget): pty:write, pty:resize, metrics:start, metrics:stop, network:startTraffic, network:stopTraffic, window:minimize, window:maximize, window:close
- `send` (M->R push): pty:data:{id}, pty:exit:{id}, metrics:data, network:traffic, network:packets

**Operational requirements:**
- Error handling: Throws in main -> rejected Promise via invoke. Push events: logged in main, last valid retained in renderer
- Logging: console (structured logging not required for v1.0)
- Configuration: settings.json, atomic .tmp->rename, fallback defaults on corrupt, validation at load
- State management: Zustand slices (renderer), service instances (main). No shared mutable state
- External dependency: systeminformation (sync), cap (handle release on shutdown, try-catch for Npcap detect)

## ASR Ledger

| ID | Quality Attribute | Target | Design Impact | Verify |
|----|-------------------|--------|---------------|--------|
| ASR-1 | Performance | key-to-pty < 16ms | Typed IPC, no hot-path middleware, pty:write as send | `pnpm test -- --run --grep "input-latency"` |
| ASR-2 | Performance | startup < 3s | Lazy panel creation, deferred addon loading | `pnpm test:e2e -- --grep "startup"` |
| ASR-3 | Performance | monitoring-update < 100ms | Debounced push, Zustand selectors, requestAnimationFrame | `pnpm test -- --run --grep "metrics-latency"` |
| ASR-4 | Performance | bundle < 15MB | Vite tree-shaking, code splitting | `du -sh out/ | awk '{print $1}'` |
| ASR-5 | Reliability | Zero PTY/collector leaks | Pane lifecycle owns create/destroy, visibility-bound collectors | `pnpm test -- --run --grep "leak"` |
| ASR-6 | Reliability | Graceful shutdown <= 5s | Sequential shutdown with timeout | `pnpm test:e2e -- --grep "shutdown"` |
| ASR-7 | Reliability | WebGL failure recovery | Canvas 2D auto-fallback on WebGL context loss | `pnpm test -- --run --grep "webgl-fallback"` |
| ASR-8 | Security | No Node.js in renderer | contextBridge only, no nodeIntegration | `bash -c '! grep -r "require(" src/renderer/'` |

## Option Matrix

| Decision | Option A (Selected) | Option B (Rejected) | Tradeoff |
|----------|-------------------|-------------------|----------|
| Split layout | Custom SplitContainer (CSS Grid recursive) | allotment library | allotment: flat model only, no asymmetric binary tree. Custom: full control, matches LayoutNode tree |
| PTY performance | 16ms frame coalescing (ADR-003) | Per-write IPC | Per-write floods renderer at high throughput. Coalescing: max 62.5 events/sec, VS Code validated |
| Terminal persistence | display:none (ADR-005) | Recreate on tab switch | Recreation: WebGL context churn, state loss. Persist: memory cost but instant switch |
| Floating panels | BrowserWindow | CSS overlay | Overlay: single-monitor only. BrowserWindow: multi-monitor, true OS window |
| State management | Zustand 5 slices | Redux / Jotai | Redux: boilerplate. Jotai: atom model mismatch. Zustand: minimal API, slice pattern |
| Linter | Biome | ESLint + Prettier | ESLint+Prettier: two tools, config overhead. Biome: single binary, faster |
| Theme tokens | `[data-theme]` attribute | :root direct | :root: no light mode path. Attribute: future theme switching |

## Lifecycle And Operations

- **Lifecycle stage:** Production (feature spec verified in C# predecessor)
- **Startup:** main -> BrowserWindow(ready-to-show) -> preload(contextBridge) -> renderer(React mount) -> first PTY -> ready
- **Shutdown:** before-quit -> 5s graceful PTY termination -> individual force kill -> save settings -> quit
- **Deployment:** Electron Forge make (Squirrel for Windows)
- **Migration:** settings.json versioned, backward-compatible schema extension
- **Observability:** console logging in v1.0, structured logging deferred
- **Recovery:** WebGL fallback to Canvas 2D, corrupt settings fallback to defaults
- **Ownership:** single developer, single desktop target (Windows 10/11)

## Quality Budgets

| Category | Budget | Risk if None |
|----------|--------|-------------|
| Performance | startup <3s, key-to-pty <16ms, monitoring <100ms, bundle <15MB, chart render <16ms(60fps) | — |
| Reliability | Zero PTY leaks, shutdown <=5s, WebGL fallback, cap handle release | — |
| Security | No nodeIntegration, contextBridge only, Npcap admin requirement documented | — |
| Cost | none declared | Single developer project, no cloud cost |
| Maintainability | Biome zero warnings, TypeScript 5.8 strict, noUncheckedIndexedAccess | — |

## Wiring Map

| ID | Aspect | Value |
|----|--------|-------|
| WM-EP1 | Entry point | `main()` in `src/main/index.ts` |
| WM-EP2 | Entry point | `createRoot()` in `src/renderer/main.tsx` |
| WM-REG1 | Registration | IPC handlers in `src/main/ipc/pty.ts`: pty:create(invoke), pty:write(on), pty:resize(on), pty:data:{id}(send), pty:exit:{id}(send), pty:kill(invoke). **Probe: runtime-load** |
| WM-REG2 | Registration | Preload API `src/preload/index.ts` via contextBridge.exposeInMainWorld('electronAPI'). **Probe: runtime-load** |
| WM-REG3 | Registration | Zustand stores `src/renderer/stores/index.ts`: tabSlice, settingsSlice, uiSlice, metricsSlice, networkSlice. **Probe: runtime-load** |
| WM-REG4 | Registration | xterm.js + addons `src/renderer/terminal/TerminalView.ts`: WebGLAddon, FitAddon, Unicode11Addon, SearchAddon. **Probe: runtime-load** |
| WM-DF1 | Data flow | Keystroke(string) -> xterm.js onData(string) -> electronAPI.pty.write(sessionId:string, data:string) -> preload send('pty:write') -> ipcMain.on('pty:write') -> PtyManager.write(id:string, data:string) -> node-pty stdin(Buffer) |
| WM-DF2 | Data flow | PTY stdout(Buffer) -> 16ms coalescer(string[]) -> concatenate(string) -> mainWindow.webContents.send('pty:data:{id}', data:string) -> preload on('pty:data:{id}') -> terminal.write(data:string) |
| WM-DF3 | Data flow | ResizeObserver(DOMRect) -> FitAddon.fit()(cols:number, rows:number) -> 100ms debounce -> electronAPI.pty.resize(sessionId:string, cols:number, rows:number) -> preload send('pty:resize') -> ipcMain.on('pty:resize') -> pty.resize(cols:number, rows:number) |
| WM-DF4 | Data flow | Settings UI(Settings) -> electronAPI.settings.save(settings:Settings) -> preload invoke('settings:save') -> ipcMain.handle('settings:save') -> SettingsService.save(settings:Settings) -> atomic .tmp write -> rename |
| WM-C1 | Contract | `PtyManager.create(shellPath?: string): { sessionId: string }` |
| WM-C2 | Contract | `PtyManager.write(sessionId: string, data: string): void` |
| WM-C3 | Contract | `PtyManager.resize(sessionId: string, cols: number, rows: number): void` |
| WM-C4 | Contract | `PtyManager.kill(sessionId: string): void` |
| WM-C5 | Contract | `PtyManager.killAll(timeout: number): Promise<void>` |
| WM-C6 | Contract | `SettingsService.load(): Settings` |
| WM-C7 | Contract | `SettingsService.save(settings: Settings): void` |
| WM-C8 | Contract | `WindowManager.createMain(): BrowserWindow` |
| WM-C9 | Contract | `WindowManager.createFloating(panelId: string): BrowserWindow` |
| WM-C10 | Contract | `WindowManager.broadcast(channel: string, ...args: unknown[]): void` |
| WM-C11 | Contract | `ElectronAPI.pty.create(shellPath?: string): Promise<{ sessionId: string }>` |
| WM-C12 | Contract | `ElectronAPI.pty.write(sessionId: string, data: string): void` |
| WM-C13 | Contract | `ElectronAPI.pty.resize(sessionId: string, cols: number, rows: number): void` |
| WM-C14 | Contract | `ElectronAPI.pty.kill(sessionId: string): Promise<void>` |
| WM-C15 | Contract | `ElectronAPI.pty.onData(sessionId: string, cb: (data: string) => void): () => void` |
| WM-C16 | Contract | `ElectronAPI.pty.onExit(sessionId: string, cb: (exitCode: number) => void): () => void` |

## Initialization Order

| Stage | Module | Prerequisite | Readiness Signal |
|-------|--------|-------------|------------------|
| 1 | main/pty | none | PtyManager instance created |
| 2 | main/settings | none | Settings loaded from file (or defaults) |
| 3 | main/metrics | none | MetricsService instance created (idle) |
| 4 | main/network | none | NetworkService instance created, Npcap detected (idle) |
| 5 | main/ipc | main/pty, main/settings, main/metrics, main/network | All IPC handlers registered |
| 6 | main/window | main/ipc | BrowserWindow ready-to-show |
| 7 | preload/api | main/window | contextBridge.exposeInMainWorld complete |
| 8 | renderer/stores | preload/api | Zustand stores initialized, electronAPI available |
| 9 | renderer/terminal | renderer/stores | First TerminalView mounted, PTY session active |

## Decision Log

| # | Decision | ADR Required | Rationale |
|---|----------|-------------|-----------|
| 1 | Electron 3-layer + typed IPC | Yes: ADR-001 | Hard to reverse, shapes all cross-process communication |
| 2 | xterm.js full delegation | Yes: ADR-002 | Eliminates custom VT parser, surprising library lock-in |
| 3 | 16ms frame coalescing | Yes: ADR-003 | Performance architecture, non-obvious timing choice |
| 4 | Custom SplitContainer (CSS Grid) | Yes: ADR-004 | Surprising library rejection, asymmetric tree requirement |
| 5 | Persist xterm via display:none | Yes: ADR-005 | WebGL context limit, tab strategy dependency |
| 6 | Visibility lifecycle binding | Yes: ADR-006 | Cross-spec pattern, collector start/stop, surprising for new readers |
| 7 | Npcap graceful degradation | Yes: ADR-007 | Two data-source paths, native privilege dependency |
| 8 | Zustand 5 slices | No | Swappable state library, low switching cost |
| 9 | Biome linter | No | Trivially reversible tool choice |
| 10 | `[data-theme]` tokens | No | Easy to reverse CSS strategy |
| 11 | pty:write/resize as send | No | Performance optimization, easily changed to invoke |
| 12 | Per-session PTY channels | No | Channel naming, easily changed to multiplexed |

## Requirements

### R1: Electron Project Structure

**ASR:** ASR-2, ASR-4, ASR-8
**Input:** Developer runs `pnpm dev`
**Behavior:** Electron Forge v7 + Vite builds and starts the app. 3-layer separation enforced: main (Node.js), preload (contextBridge), renderer (React). TypeScript 5.8 strict with noUncheckedIndexedAccess. Phosphor 17 design tokens on `[data-theme='dark']`. electron-rebuild hook for native modules. Biome config for lint+format.
**Output:** Running Electron app with BrowserWindow
**Impact scope:**
- All modules: project foundation
**Acceptance criteria:**
- [ ] Given: Clean project with dependencies installed
      When: `pnpm build` executes
      Then: `out/` directory created with packaged Electron app
      Verify: `pnpm build && test -d out/`
      Verify-type: cli
      Automatable: true
- [ ] Given: TypeScript source files
      When: `pnpm typecheck` executes
      Then: Zero type errors reported
      Verify: `pnpm typecheck`
      Verify-type: cli
      Automatable: true
- [ ] Given: Renderer source directory
      When: Scanning for Node.js require calls
      Then: No require() calls found in src/renderer/
      Verify: `bash -c '! grep -r "require(" src/renderer/'`
      Verify-type: cli
      Automatable: true
- [ ] Given: All source files
      When: `pnpm lint` executes
      Then: Zero Biome warnings
      Verify: `pnpm lint`
      Verify-type: cli
      Automatable: true
**Edge cases:**
- Missing native module rebuild: electron-rebuild must run on install

### R2: PTY Session Management

**ASR:** ASR-1, ASR-5
**Input:** New tab or pane creation
**Behavior:** PtyManager creates a node-pty process with UUID session ID. Shell path from settings or OS default. 16ms coalesced stdout via pty:data:{id} push events. pty:write and pty:resize use fire-and-forget send pattern. pty:exit:{id} fires on shell exit with exit code. Sessions tracked in Map, cleaned up on pane close.
**Output:** Active PTY session bound to pane
**Impact scope:**
- main/pty: PtyManager CRUD
- main/ipc: pty channel handlers
- preload/api: electronAPI.pty surface
**Acceptance criteria:**
- [ ] Given: App running
      When: New tab created
      Then: PtyManager creates PTY, returns sessionId (UUID)
      Verify: `pnpm test -- --run --grep "pty-create"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Active PTY session
      When: Characters typed
      Then: Input echoed back via pty:data:{id} within 16ms
      Verify: `pnpm test -- --run --grep "input-latency"`
      Verify-type: lib
      Automatable: true
- [ ] Given: PTY shell exits
      When: Process terminates
      Then: pty:exit:{id} event fired with exit code, session removed from map
      Verify: `pnpm test -- --run --grep "pty-exit"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Multiple PTY sessions created and destroyed
      When: All panes closed
      Then: PtyManager session map is empty, no orphan processes
      Verify: `pnpm test -- --run --grep "leak"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Shell path not found: PtyManager falls back to OS default
- PTY spawn failure: Error propagated via invoke reject, pane not created

### R3: xterm.js Terminal Rendering

**ASR:** ASR-7
**Input:** PTY data arrives via pty:data:{id}
**Behavior:** xterm.js Terminal instance receives data via terminal.write(). WebGLAddon loaded first; on context loss, FitAddon.fit() recalculates and Canvas 2D renderer activated. FitAddon handles resize, Unicode11Addon for CJK width, SearchAddon for find. 20K line scrollback. Theme from Phosphor tokens.
**Output:** VT-rendered terminal content
**Impact scope:**
- renderer/terminal: TerminalView wrapper
**Acceptance criteria:**
- [ ] Given: Terminal mounted
      When: VT escape sequences received (colors, cursor, clear)
      Then: xterm.js renders colors, cursor movement, and screen clear matching expected output
      Verify: `pnpm test -- --run --grep "vt-render"`
      Verify-type: lib
      Automatable: true
- [ ] Given: WebGL context lost
      When: Fallback triggered
      Then: Canvas 2D renderer activates, terminal continues functioning
      Verify: `pnpm test -- --run --grep "webgl-fallback"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Korean or emoji characters received
      When: Rendered by xterm.js with Unicode11Addon
      Then: Characters occupy correct cell width (2 cells for CJK)
      Verify: `pnpm test -- --run --grep "unicode-width"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- WebGL unavailable from start: Canvas 2D used immediately, no error

### R4: Keyboard Input Processing

**ASR:** ASR-1
**Input:** Key press in focused terminal
**Behavior:** attachCustomKeyEventHandler intercepts app shortcuts (Ctrl+T, Ctrl+W, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+1~9, Ctrl+Shift+D, Ctrl+Shift+S, Ctrl+Shift+Z, Ctrl+Shift+W, Ctrl+Shift+P, Ctrl+F) before they reach PTY. All other keys pass through to xterm.js -> onData -> pty:write. Ctrl+C: if selection exists, copy to clipboard; else send SIGINT (0x03). Ctrl+V: read clipboard, send as bracketed paste.
**Output:** App shortcut executed OR character sent to PTY
**Impact scope:**
- renderer/terminal: key handler
- renderer/components: shortcut dispatch
**Acceptance criteria:**
- [ ] Given: Terminal focused
      When: Ctrl+T pressed
      Then: New tab created, keypress NOT sent to PTY
      Verify: `pnpm test -- --run --grep "shortcut-intercept"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Terminal focused, no selection
      When: Regular character typed
      Then: Character sent to PTY via pty:write
      Verify: `pnpm test -- --run --grep "key-passthrough"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Terminal has text selection
      When: Ctrl+C pressed
      Then: Selected text copied to clipboard, not sent to PTY
      Verify: `pnpm test -- --run --grep "ctrl-c-copy"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Ctrl+C with no selection: sends 0x03 (SIGINT) to PTY
- Application cursor mode: arrow keys send escape sequences, not intercepted

### R5: Resize Handling

**ASR:** ASR-1
**Input:** Window or panel size change
**Behavior:** FitAddon calculates new cols/rows from container dimensions. 100ms debounce prevents rapid-fire resizes. If cols/rows unchanged (e.g., panel toggle without terminal size change), no IPC sent. pty:resize sent as fire-and-forget (send pattern).
**Output:** PTY and terminal synchronized to new dimensions
**Impact scope:**
- renderer/terminal: FitAddon integration
- main/pty: PtyManager.resize
**Acceptance criteria:**
- [ ] Given: Terminal displayed
      When: Window resized
      Then: Terminal cols/rows recalculated, pty:resize sent after 100ms debounce
      Verify: `pnpm test -- --run --grep "resize-debounce"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Panel toggled
      When: Terminal cols/rows unchanged
      Then: No pty:resize IPC sent
      Verify: `pnpm test -- --run --grep "resize-skip"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Rapid sequential resizes: only final dimensions sent after debounce

### R6: Multi-Tab Management

**ASR:** none
**Input:** Tab keyboard shortcuts or UI clicks
**Behavior:** Ctrl+T creates new tab with fresh PTY. Ctrl+Tab/Ctrl+Shift+Tab cycles tabs. Ctrl+1~9 switches to tab N (9=last). Ctrl+W closes tab (blocked if last tab). Zustand tabSlice manages tab array and activeTabId.
**Output:** Active tab switched, tab created/closed
**Impact scope:**
- renderer/stores: tabSlice
- renderer/components: TabBar
**Acceptance criteria:**
- [ ] Given: App running with one tab
      When: Ctrl+T pressed
      Then: New tab created with fresh PTY, becomes active
      Verify: `pnpm test -- --run --grep "tab-create"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 3 tabs open, tab 1 active
      When: Ctrl+Tab pressed
      Then: Tab 2 becomes active
      Verify: `pnpm test -- --run --grep "tab-cycle"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Only 1 tab open
      When: Ctrl+W pressed
      Then: Close blocked, tab remains
      Verify: `pnpm test -- --run --grep "last-tab-block"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Ctrl+9 with 3 tabs: switches to tab 3 (last)
- Close tab with multiple panes: all panes and PTY sessions disposed

### R7: Binary Tree Pane Split

**ASR:** none
**Input:** Split command (Ctrl+Shift+D right, Ctrl+Shift+S down)
**Behavior:** LayoutNode tree: LeafNode (single pane) | SplitNode (orientation + ratio + first/second). Max 4 panes per tab (max depth 3). Pure functions: split(node, paneId, orientation) -> new tree; remove(node, paneId) -> rebalanced tree; find(node, paneId) -> LeafNode; resize(node, ratio) -> updated ratios; zoom(node, paneId) -> zoomed/unzoomed; flatten(node) -> paneId[]. Immutable updates (no Immer).
**Output:** Updated LayoutNode tree in tabSlice
**Impact scope:**
- renderer/stores: tabSlice (layout operations)
**Acceptance criteria:**
- [ ] Given: Single pane tab
      When: Split right executed
      Then: LayoutNode becomes SplitNode with horizontal orientation, two LeafNodes
      Verify: `pnpm test -- --run --grep "split-create"`
      Verify-type: pure
      Automatable: true
- [ ] Given: 4 panes in tab
      When: Split attempted
      Then: Split rejected, max pane limit enforced
      Verify: `pnpm test -- --run --grep "split-limit"`
      Verify-type: pure
      Automatable: true
- [ ] Given: 3 panes in asymmetric tree
      When: Middle pane removed
      Then: Tree rebalanced, remaining 2 panes valid
      Verify: `pnpm test -- --run --grep "split-remove"`
      Verify-type: pure
      Automatable: true
**Edge cases:**
- null root (empty tab): treated as no panes, next action creates LeafNode
- flatten on deeply nested tree: returns flat paneId array

### R8: Custom SplitContainer

**ASR:** none
**Input:** LayoutNode tree from tabSlice
**Behavior:** LeafNode renders TerminalView. SplitNode renders CSS Grid with two children and 6px draggable gutter. Gutter drag updates ratio in tabSlice. Double-click gutter resets to 50:50. Recursive rendering for nested splits. Orphan pane detection (pane ID in tree but no matching PaneState) renders error boundary.
**Output:** Visual split layout matching tree structure
**Impact scope:**
- renderer/components: SplitContainer, Gutter
**Acceptance criteria:**
- [ ] Given: SplitNode with 2 children
      When: Rendered
      Then: CSS Grid with correct ratio, 6px gutter visible
      Verify: `pnpm test -- --run --grep "split-render"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Gutter between two panes
      When: Dragged to 70:30 ratio
      Then: tabSlice ratio updated, panes resized
      Verify: `pnpm test -- --run --grep "gutter-drag"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Gutter at non-50:50 ratio
      When: Double-clicked
      Then: Ratio resets to 50:50
      Verify: `pnpm test -- --run --grep "gutter-reset"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Orphan pane ID: error boundary rendered instead of TerminalView

### R9: Pane Focus & Zoom

**ASR:** none
**Input:** Click, keyboard navigation, or zoom shortcut
**Behavior:** Click on terminal focuses pane (activePaneId in tabSlice). Ctrl+Alt+Arrow navigates to adjacent pane. Ctrl+Shift+Z toggles zoom: zoomed pane fills tab area (siblings display:none per ADR-005), split commands blocked during zoom. Zoom exit restores previous layout.
**Output:** Focused or zoomed pane state
**Impact scope:**
- renderer/stores: tabSlice (focus, zoom)
- renderer/components: SplitContainer (zoom overlay)
**Acceptance criteria:**
- [ ] Given: Two panes, left focused
      When: Right pane clicked
      Then: activePaneId changes to right pane
      Verify: `pnpm test -- --run --grep "pane-focus"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Two panes, left focused
      When: Ctrl+Shift+Z pressed
      Then: Left pane fills tab, right pane display:none
      Verify: `pnpm test -- --run --grep "pane-zoom"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Zoomed pane
      When: Split command issued
      Then: Split rejected while zoomed
      Verify: `pnpm test -- --run --grep "zoom-block-split"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Ctrl+Alt+Arrow at edge: stays at current pane (no wrap)

### R10: Pane Lifecycle

**ASR:** ASR-5
**Input:** Pane creation, shell exit, manual close
**Behavior:** Split creates new pane + PTY session. Shell exit (pty:exit:{id}) auto-closes pane. Last pane in last tab: restart shell instead of close. Ctrl+Shift+W closes active pane. Pane close triggers async PTY dispose (kill + cleanup). Terminal instance disposed (WebGL context freed).
**Output:** Pane added/removed from layout
**Impact scope:**
- renderer/stores: tabSlice (layout mutation)
- main/pty: session lifecycle
**Acceptance criteria:**
- [ ] Given: Shell process exits normally
      When: pty:exit:{id} received
      Then: Pane removed from tree, PTY session cleaned up
      Verify: `pnpm test -- --run --grep "pane-auto-close"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Last pane in last tab
      When: Shell exits
      Then: Shell restarted in same pane, pane not closed
      Verify: `pnpm test -- --run --grep "last-pane-restart"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Multiple panes
      When: Ctrl+Shift+W pressed
      Then: Active pane closed, PTY killed, tree rebalanced
      Verify: `pnpm test -- --run --grep "pane-manual-close"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Rapid close of multiple panes: async dispose prevents race conditions

### R11: Desktop Shell Layout

**ASR:** ASR-2
**Input:** App startup
**Behavior:** Layout: TitleBar 32px (custom frameless), TabBar 36px, Content area (Terminal between Rail 48px left and Panel 300px right), StatusBar 22px. Min window 800x600. Panel collapsible (hidden = terminal fills width). Phosphor 17 theme tokens applied.
**Output:** Rendered desktop shell
**Impact scope:**
- renderer/components: AppShell, TitleBar, TabBar, StatusBar, Rail, Panel
**Acceptance criteria:**
- [ ] Given: App started
      When: Window renders
      Then: TitleBar 32px, TabBar 36px, Rail 48px, StatusBar 22px visible
      Verify: `pnpm test:e2e -- --grep "layout-dimensions"`
      Verify-type: e2e
      Automatable: true
- [ ] Given: Panel hidden
      When: Terminal area measured
      Then: Terminal fills available width (no 300px gap)
      Verify: `pnpm test:e2e -- --grep "panel-collapse"`
      Verify-type: e2e
      Automatable: true
**Edge cases:**
- Window at min size (800x600): layout still functional, no overflow

### R12: Rail Panel System

**ASR:** none
**Input:** Rail icon click
**Behavior:** 4 Rail icons: Files (disabled/future), Status, Network, Settings. Click toggles panel open/close. Click different icon switches panel content. Panels created lazily on first access (not at app startup). uiSlice.activePanel tracks current.
**Output:** Panel opened/closed/switched
**Impact scope:**
- renderer/stores: uiSlice
- renderer/components: Rail, PanelHost
**Acceptance criteria:**
- [ ] Given: Panel closed
      When: Status icon clicked
      Then: Status panel opens at 300px, uiSlice.activePanel = 'status'
      Verify: `pnpm test -- --run --grep "panel-toggle"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Status panel open
      When: Network icon clicked
      Then: Panel switches to Network content
      Verify: `pnpm test -- --run --grep "panel-switch"`
      Verify-type: lib
      Automatable: true
- [ ] Given: App just started
      When: Status panel first opened
      Then: StatusPanel component created (lazy)
      Verify: `pnpm test -- --run --grep "panel-lazy"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Files icon: shows disabled tooltip, no panel opened

### R13: Context Menu

**ASR:** none
**Input:** Right-click on terminal
**Behavior:** Context menu with 12 items: Copy, Paste, Paste & Run, separator, Find, Save Scrollback, separator, Clear, Reset Shell, Kill Process, separator, Split Right, Split Down, Close Pane. ESC or click outside closes. Copy disabled when no selection.
**Output:** Menu action executed
**Impact scope:**
- renderer/components: ContextMenu
**Acceptance criteria:**
- [ ] Given: Terminal right-clicked
      When: Menu renders
      Then: 12 items displayed in correct order
      Verify: `pnpm test -- --run --grep "context-menu-items"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Context menu open
      When: ESC pressed
      Then: Menu closes, focus returns to terminal
      Verify: `pnpm test -- --run --grep "context-menu-close"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- No selection: Copy item disabled (grayed)

### R14: Find Bar

**ASR:** none
**Input:** Ctrl+F
**Behavior:** Find bar opens above terminal. SearchAddon.findNext/findPrevious with match count display. Enter = next, Shift+Enter = previous. Toggles: regex, case-sensitive, whole word. ESC closes and returns focus to terminal.
**Output:** Search matches highlighted in terminal
**Impact scope:**
- renderer/components: FindBar
- renderer/terminal: SearchAddon integration
**Acceptance criteria:**
- [ ] Given: Terminal with text content
      When: Ctrl+F pressed, search term entered
      Then: Match count displayed, first match highlighted
      Verify: `pnpm test -- --run --grep "find-bar"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Find bar open with matches
      When: Enter pressed
      Then: Next match highlighted
      Verify: `pnpm test -- --run --grep "find-navigate"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Find bar open
      When: ESC pressed
      Then: Bar closes, terminal re-focused
      Verify: `pnpm test -- --run --grep "find-close"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- No matches: count shows "0 of 0", no highlight

### R15: Command Palette

**ASR:** none
**Input:** Ctrl+Shift+P
**Behavior:** Overlay palette with text filter. 14 commands: New Tab, Close Tab, Split Right, Split Down, Close Pane, Toggle Zoom, Focus Next Pane, Toggle Status Panel, Toggle Network Panel, Toggle Settings Panel, Find, Clear Terminal, Reset Shell, Kill Process. Filter by typing. Enter executes selected. ESC closes.
**Output:** Selected command executed
**Impact scope:**
- renderer/components: CommandPalette
**Acceptance criteria:**
- [ ] Given: App running
      When: Ctrl+Shift+P pressed
      Then: Palette opens with 14 commands listed
      Verify: `pnpm test -- --run --grep "palette-open"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Palette open
      When: "split" typed
      Then: Filtered to Split Right and Split Down
      Verify: `pnpm test -- --run --grep "palette-filter"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- All commands filtered out: "No results" message

### R16: Floating Panels

**ASR:** none
**Input:** Panel pop-out action
**Behavior:** Creates new BrowserWindow hosting panel content. Main panel slot cleared. Dock action returns content to main window. IPC broadcast syncs state between windows. Collector lifecycle (metrics/network) tied to floating window visibility.
**Output:** Detached panel window
**Impact scope:**
- main/window: WindowManager.createFloating
- renderer/components: PanelHost
**Acceptance criteria:**
- [ ] Given: Status panel open in main window
      When: Pop-out action triggered
      Then: New BrowserWindow opens with Status panel, main slot empty
      Verify: `pnpm test:e2e -- --grep "floating-panel"`
      Verify-type: e2e
      Automatable: true
- [ ] Given: Floating Status panel
      When: Dock action triggered
      Then: Floating window closes, Status panel returns to main window
      Verify: `pnpm test:e2e -- --grep "panel-dock"`
      Verify-type: e2e
      Automatable: true
**Edge cases:**
- Floating window closed via OS close button: treated as dock (content returns)

### R17: Settings Panel

**ASR:** none
**Input:** Settings panel opened via Rail
**Behavior:** Editable fields: shell path, font family, font size (slider/input), color scheme (dropdown). Live preview for font changes. Save triggers electronAPI.settings.save -> atomic .tmp -> rename. Load failure (corrupt file) uses fallback defaults.
**Output:** Settings persisted or previewed
**Impact scope:**
- renderer/components: SettingsPanel
- main/settings: SettingsService
**Acceptance criteria:**
- [ ] Given: Settings panel open
      When: Font size changed
      Then: Terminal preview updates immediately (before save)
      Verify: `pnpm test -- --run --grep "settings-preview"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Valid settings
      When: Save triggered
      Then: .tmp file written, renamed to settings.json atomically
      Verify: `pnpm test -- --run --grep "settings-save"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Corrupt settings.json on disk
      When: App starts
      Then: Fallback defaults loaded, user notified
      Verify: `pnpm test -- --run --grep "settings-fallback"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- .tmp rename failure (permission): retry once, then log error

### R18: App Lifecycle

**ASR:** ASR-2, ASR-5, ASR-6
**Input:** App start or quit
**Behavior:**
- Startup (9 stages): main/pty -> main/settings -> main/metrics(idle) -> main/network(Npcap detect, idle) -> main/ipc(all handlers) -> main/window(ready-to-show) -> preload/api(contextBridge) -> renderer/stores(Zustand) -> renderer/terminal(first PTY)
- Shutdown: before-quit -> 5s graceful PTY termination (killAll with timeout) -> individual force kill for survivors -> save settings -> app.quit()
**Output:** App started or cleanly shut down
**Impact scope:**
- main/index.ts: lifecycle orchestration
- All modules: initialization and cleanup
**Acceptance criteria:**
- [ ] Given: App installed
      When: Launched
      Then: Shell prompt visible within 3 seconds
      Verify: `pnpm test:e2e -- --grep "startup"`
      Verify-type: e2e
      Automatable: true
- [ ] Given: App running with 3 PTY sessions
      When: Quit initiated
      Then: All PTYs terminated within 5 seconds, settings saved
      Verify: `pnpm test:e2e -- --grep "shutdown"`
      Verify-type: e2e
      Automatable: true
- [ ] Given: PTY not responding to SIGTERM
      When: 5s timeout expires
      Then: Force kill applied, app exits cleanly
      Verify: `pnpm test:e2e -- --grep "force-kill"`
      Verify-type: e2e
      Automatable: true
**Edge cases:**
- Window close (X button): triggers before-quit, same shutdown sequence
- Multiple windows (floating panels): all closed before PTY cleanup

### R19: Split Indicator

**ASR:** none
**Input:** Tab label rendering
**Behavior:** Tab label shows miniature split layout icon. LeafNode = single rectangle. SplitNode = split rectangle matching orientation. Renders asymmetric tree structure. null root = empty rectangle.
**Output:** Visual split indicator in tab bar
**Impact scope:**
- renderer/components: TabSplitIndicator
**Acceptance criteria:**
- [ ] Given: Tab with single pane
      When: Tab label rendered
      Then: Single rectangle indicator displayed
      Verify: `pnpm test -- --run --grep "indicator-single"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Tab with horizontal split (2 panes)
      When: Tab label rendered
      Then: Split rectangle with vertical divider
      Verify: `pnpm test -- --run --grep "indicator-split"`
      Verify-type: lib
      Automatable: true
- [ ] Given: null layout root
      When: Tab label rendered
      Then: Empty rectangle, no crash
      Verify: `pnpm test -- --run --grep "indicator-null"`
      Verify-type: pure
      Automatable: true
**Edge cases:**
- 4-pane asymmetric tree: nested rectangles, readable at tab label size
