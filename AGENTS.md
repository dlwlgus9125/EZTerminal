# EZTerminal
> Electron 기반 로컬 터미널 에뮬레이터. 시스템/네트워크 모니터링 포함.

## Steering
- spec location: docs/specs/
- plan location: docs/plans/
- fully automated verification: e2e AC에 실행 가능한 Verify 커맨드 필수. 수동 확인 항목은 Automatable: false로 명시하고, /plan에서 자동 프로브로 대체. Verify 커맨드 없는 e2e AC는 자동 FAIL. Verify 커맨드는 실행 시점에 plan file에서 추출 — 캐시/메모리/구현자 보고서가 아닌 plan file이 유일한 원본 (ezpowers 1.3.2 Verify Fidelity Gate).
- wiring: config.json에 wiring 블록 필수 (enabled: true). view-bearing task는 view wiring verification 필수. wiring test 파일 명명: *.wiring.test.tsx.

## Current Scope
- Electron 3-layer: main (node-pty, IPC handlers, metrics, network, settings), preload (typed contextBridge), renderer (React 19, Zustand, xterm.js)
- PTY: node-pty 1.0, 16ms frame coalescing, UUID sessions, 5 IPC channels (pty:create, pty:write, pty:resize, pty:data, pty:exit)
- Terminal: xterm.js 5 + WebGL/Canvas fallback, addon-fit, addon-search, scrollback 20K
- Multi-tab/split: Zustand slices, LayoutNode binary tree, max 4 panes, custom SplitContainer (CSS Grid recursive)
- UI: custom titlebar, tab bar, Terminal | Rail(48px) | Panel 300px, status bar
- Rail panels: Status, Network, Settings — lazy creation, visibility-bound lifecycle
- Floating panels: separate BrowserWindow, pop-out/dock round-trip
- System monitoring: systeminformation 5 (CPU/mem/disk/process/GPU)
- Network monitoring: cap 0.3 (Npcap), traffic, packet capture, hex dump, connection table
- Settings: atomic .tmp → rename persistence

## Stack
- Electron (Forge v7 + Vite)
- React 19 + Zustand 5
- TypeScript 5.8 strict
- xterm.js 5 + WebGL + fit + unicode11 + search addons
- node-pty 1.0
- CSS Modules + CSS custom properties (Phosphor 17 tokens)
- Vitest 3 + Playwright + @testing-library/react
- Biome
- systeminformation 5
- cap 0.3 (Npcap)
- pnpm 10

## Conventions
Coding rules: see `docs/reference/conventions.md`.
- Code Style: TypeScript strict, noUncheckedIndexedAccess, no `any`, no `as` casts without justification
- Architecture: main ← preload ← renderer. Renderer never imports main modules directly
- IPC: all cross-process communication through typed contextBridge channels
- Terminal UX: keyboard events must reach PTY, resize is logical cols/rows only
- Rendering: xterm.js WebGL with Canvas fallback, no blur/transition/glow effects
- Lifecycle: PTY sessions created/destroyed with pane lifecycle, collectors bound to panel visibility
- Testing: Vitest for unit/component, Playwright for e2e Electron, @testing-library/react for components

## Boundaries
- No custom VT parser. xterm.js handles all VT rendering.
- No remote server in current scope. Future phase only.
- No iOS support. Mobile is future Android only.
- No blur/transition/glow effects in rendering hot path.
- No SkiaSharp or native rendering. Electron + xterm.js WebGL only.
- No external process dependencies (btop/psnet). Self-contained monitoring via systeminformation + cap.
- PTY via node-pty only, no direct Win32 API calls.
- Last tab/pane close is blocked. Always preserve at least one.
- Keyboard open/close is viewport change, not resize (from previous implementation lesson).

## Review Settings
review-skip:
