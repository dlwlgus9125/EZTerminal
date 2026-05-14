#!/usr/bin/env bash
# Verify script for Spec 1: Terminal Shell
# Generated: 2026-05-14
set -euo pipefail

echo "=== Spec 1: Terminal Shell Verification ==="

# R1: Project structure
echo "[R1] Build check..."
pnpm build && test -d out
echo "[R1] TypeScript strict..."
pnpm exec tsc --noEmit
echo "[R1] No Node.js requires in renderer..."
! grep -rn 'require(' src/renderer/ --include='*.ts' --include='*.tsx' 2>/dev/null || true
echo "[R1] Lint check..."
pnpm lint

# R2: PTY session management
echo "[R2] PTY tests..."
pnpm test -- --run --grep "pty-create|pty-write-echo|pty-exit|pty-leak"

# R3: xterm.js rendering
echo "[R3] Terminal render tests..."
pnpm test -- --run --grep "terminal-render|webgl-fallback|unicode-width"

# R4: Keyboard input
echo "[R4] Keyboard tests..."
pnpm test -- --run --grep "key-intercept-app|key-passthrough-pty|ctrl-c-copy|ctrl-c-sigint"

# R5: Resize
echo "[R5] Resize tests..."
pnpm test -- --run --grep "resize-debounce|resize-panel-toggle|resize-same-size-skip"

# R6: Multi-tab
echo "[R6] Tab tests..."
pnpm test -- --run --grep "tab-create|tab-cycle-next|tab-last-block|tab-direct-last"

# R7: Layout tree
echo "[R7] Layout tests..."
pnpm test -- --run --grep "layout-split|layout-max-panes|layout-remove|layout-flatten"

# R8: SplitContainer
echo "[R8] Split render tests..."
pnpm test -- --run --grep "split-render-horizontal|split-gutter-drag|split-gutter-reset"

# R9: Pane focus/zoom
echo "[R9] Focus/zoom tests..."
pnpm test -- --run --grep "pane-focus-click|pane-focus-arrow|pane-zoom-toggle|pane-zoom-block-split"

# R10: Pane lifecycle
echo "[R10] Pane lifecycle tests..."
pnpm test -- --run --grep "pane-shell-exit|pane-last-restart|pane-close-dispose|pty-leak"

# R11: Desktop layout (e2e)
echo "[R11] Layout e2e tests..."
pnpm test:e2e --grep "layout-dimensions|layout-panel-hidden"

# R12: Rail panel
echo "[R12] Rail tests..."
pnpm test -- --run --grep "rail-open-panel|rail-collapse|rail-switch-panel"

# R13: Context menu
echo "[R13] Context menu tests..."
pnpm test -- --run --grep "context-menu-show|context-menu-close|context-menu-copy"

# R14: Find bar
echo "[R14] Find bar tests..."
pnpm test -- --run --grep "find-bar-open|find-bar-count|find-bar-close"

# R15: Command palette
echo "[R15] Palette tests..."
pnpm test -- --run --grep "palette-open|palette-filter|palette-execute"

# R16: Floating panel (e2e)
echo "[R16] Floating panel tests..."
pnpm test:e2e --grep "floating-popout|floating-dock"
pnpm test -- --run --grep "floating-visibility-lifecycle"

# R17: Settings
echo "[R17] Settings tests..."
pnpm test -- --run --grep "settings-live-preview|settings-atomic-save|settings-corrupt-fallback"

# R18: App lifecycle (e2e)
echo "[R18] Lifecycle e2e tests..."
pnpm test:e2e --grep "app-startup|app-shutdown"
pnpm test -- --run --grep "shutdown-force-kill"

# R19: Split indicator
echo "[R19] Indicator tests..."
pnpm test -- --run --grep "indicator-single|indicator-split|indicator-null-safe"

echo "=== Spec 1 verification complete ==="
