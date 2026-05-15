---
doc_type: reference
authority: canonical
status: active
---

# Project Conventions

These conventions describe the Electron + React + TypeScript codebase.

## Code Style

### [critical] TypeScript strict mode with noUncheckedIndexedAccess

`tsconfig.json` must include `strict: true` and `noUncheckedIndexedAccess: true`.

### [critical] No `any` type

Use `unknown` and narrow. `any` requires justification comment.

### [critical] No unguarded `as` casts

Type assertions require preceding runtime check or justification comment.

### [important] Biome formatting and linting

All code must pass `pnpm lint` (Biome check).

## Architecture

### [critical] Electron 3-layer separation

main → preload → renderer. Renderer never imports Node.js or main process modules.

Verify:
```bash
pnpm lint
```

### [critical] IPC through contextBridge only

All cross-process communication uses typed preload API. No `ipcRenderer.send` in renderer code.

### [critical] PTY in main process only

node-pty runs exclusively in main process. Renderer interacts through IPC channels.

## Terminal UX

### [critical] Keyboard events must reach PTY

Ctrl+C, Ctrl+Z, Tab, arrows, paste, bracketed paste, application cursor mode must map to expected bytes. App shortcuts intercepted via `attachCustomKeyEventHandler`.

### [critical] Resize is logical terminal resize only

Only actual cols/rows changes trigger PTY resize. 100ms debounce via addon-fit. Panel toggles that don't change cols/rows must not trigger resize.

### [critical] No blur/transition/glow effects

Static styling and direct state changes only. No rendering-cost effects.

## Lifecycle

### [important] PTY session lifecycle bound to pane

Pane creation → PTY spawn. Shell exit → auto close pane. Last pane in last tab → restart shell, not close.

### [important] Panels are lazy and visibility-lifecycle-bound

Status, Network, Settings created on first access. Collectors start/stop with panel visibility state.

### [important] Shutdown sequence

app before-quit → 5s graceful PTY termination → individual force kill → save settings → quit.

### [important] Last tab/pane close blocked

Always preserve at least one tab with at least one pane.

## Testing

### [important] Unit tests for pure logic

LayoutNode operations, settings persistence, IPC message serialization.

### [important] Component tests for React views

@testing-library/react for component behavior.

### [important] E2E tests for Electron integration

Playwright for full Electron app testing.

### [advisory] Run the Electron app for user-facing UI changes

Automated tests required first. Visual workflows must also be verified in running app.

## View Wiring Tests

### [important] Wiring test file naming

View wiring tests use the pattern `*.wiring.test.tsx` and live alongside their source files.

### [important] Preload API mock pattern

Wiring tests mock `window.electronAPI` with a typed stub object. Do not mock individual IPC channels — mock the full preload API surface to verify integration contracts.

### [important] Wiring test scope

Each wiring test verifies:
- Component binds to the correct store slice (binding resolution)
- Event handlers are connected to the correct preload API methods (handler connection)
- Required dependencies (stores, preload API) are available at mount time (dependency resolution)
