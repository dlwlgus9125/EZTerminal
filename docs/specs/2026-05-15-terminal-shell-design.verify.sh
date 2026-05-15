#!/usr/bin/env bash
set -euo pipefail

echo "=== Spec 1: Terminal Shell Design Verification ==="

echo "[R1] Build"
pnpm build && test -d out/

echo "[R1] Typecheck"
pnpm typecheck

echo "[R1] No require in renderer"
! grep -r "require(" src/renderer/

echo "[R1] Lint"
pnpm lint

echo "[R2] PTY create"
pnpm test -- --run --grep "pty-create"

echo "[R2] Input latency"
pnpm test -- --run --grep "input-latency"

echo "[R2] PTY exit"
pnpm test -- --run --grep "pty-exit"

echo "[R2] Leak check"
pnpm test -- --run --grep "leak"

echo "[R3] VT render"
pnpm test -- --run --grep "vt-render"

echo "[R3] WebGL fallback"
pnpm test -- --run --grep "webgl-fallback"

echo "[R3] Unicode width"
pnpm test -- --run --grep "unicode-width"

echo "[R4] Shortcut intercept"
pnpm test -- --run --grep "shortcut-intercept"

echo "[R4] Key passthrough"
pnpm test -- --run --grep "key-passthrough"

echo "[R4] Ctrl-C copy"
pnpm test -- --run --grep "ctrl-c-copy"

echo "[R5] Resize debounce"
pnpm test -- --run --grep "resize-debounce"

echo "[R5] Resize skip"
pnpm test -- --run --grep "resize-skip"

echo "[R6] Tab create"
pnpm test -- --run --grep "tab-create"

echo "[R6] Tab cycle"
pnpm test -- --run --grep "tab-cycle"

echo "[R6] Last tab block"
pnpm test -- --run --grep "last-tab-block"

echo "[R7] Split create"
pnpm test -- --run --grep "split-create"

echo "[R7] Split limit"
pnpm test -- --run --grep "split-limit"

echo "[R7] Split remove"
pnpm test -- --run --grep "split-remove"

echo "[R8] Split render"
pnpm test -- --run --grep "split-render"

echo "[R8] Gutter drag"
pnpm test -- --run --grep "gutter-drag"

echo "[R8] Gutter reset"
pnpm test -- --run --grep "gutter-reset"

echo "[R9] Pane focus"
pnpm test -- --run --grep "pane-focus"

echo "[R9] Pane zoom"
pnpm test -- --run --grep "pane-zoom"

echo "[R9] Zoom block split"
pnpm test -- --run --grep "zoom-block-split"

echo "[R10] Pane auto close"
pnpm test -- --run --grep "pane-auto-close"

echo "[R10] Last pane restart"
pnpm test -- --run --grep "last-pane-restart"

echo "[R10] Pane manual close"
pnpm test -- --run --grep "pane-manual-close"

echo "[R11] Layout dimensions"
pnpm test:e2e -- --grep "layout-dimensions"

echo "[R11] Panel collapse"
pnpm test:e2e -- --grep "panel-collapse"

echo "[R12] Panel toggle"
pnpm test -- --run --grep "panel-toggle"

echo "[R12] Panel switch"
pnpm test -- --run --grep "panel-switch"

echo "[R12] Panel lazy"
pnpm test -- --run --grep "panel-lazy"

echo "[R13] Context menu items"
pnpm test -- --run --grep "context-menu-items"

echo "[R13] Context menu close"
pnpm test -- --run --grep "context-menu-close"

echo "[R14] Find bar"
pnpm test -- --run --grep "find-bar"

echo "[R14] Find navigate"
pnpm test -- --run --grep "find-navigate"

echo "[R14] Find close"
pnpm test -- --run --grep "find-close"

echo "[R15] Palette open"
pnpm test -- --run --grep "palette-open"

echo "[R15] Palette filter"
pnpm test -- --run --grep "palette-filter"

echo "[R16] Floating panel"
pnpm test:e2e -- --grep "floating-panel"

echo "[R16] Panel dock"
pnpm test:e2e -- --grep "panel-dock"

echo "[R17] Settings preview"
pnpm test -- --run --grep "settings-preview"

echo "[R17] Settings save"
pnpm test -- --run --grep "settings-save"

echo "[R17] Settings fallback"
pnpm test -- --run --grep "settings-fallback"

echo "[R18] Startup"
pnpm test:e2e -- --grep "startup"

echo "[R18] Shutdown"
pnpm test:e2e -- --grep "shutdown"

echo "[R18] Force kill"
pnpm test:e2e -- --grep "force-kill"

echo "[R19] Indicator single"
pnpm test -- --run --grep "indicator-single"

echo "[R19] Indicator split"
pnpm test -- --run --grep "indicator-split"

echo "[R19] Indicator null"
pnpm test -- --run --grep "indicator-null"

echo "=== All Spec 1 verifications passed ==="
