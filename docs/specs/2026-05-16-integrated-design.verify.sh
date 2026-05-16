#!/usr/bin/env bash
# Verify script for EZTerminal Integrated Design Spec
# Usage: bash docs/specs/2026-05-16-integrated-design.verify.sh [layer]
# layer: l1, l2, l3, l4, all (default: all)

set -euo pipefail

LAYER="${1:-all}"
PASS=0
FAIL=0
SKIP=0

log_pass() { echo "[PASS] $1"; ((PASS++)); }
log_fail() { echo "[FAIL] $1"; ((FAIL++)); }
log_skip() { echo "[SKIP] $1"; ((SKIP++)); }

run_check() {
  local name="$1"
  local cmd="$2"
  if eval "$cmd" > /dev/null 2>&1; then
    log_pass "$name"
  else
    log_fail "$name"
  fi
}

# --- Layer 1: Terminal Core ---
verify_l1() {
  echo "=== Layer 1: Terminal Core ==="

  # R-L1-01: Shared types exist
  run_check "R-L1-01: ipc-types.ts exists" "test -f src/shared/ipc-types.ts"
  run_check "R-L1-01: terminal-types.ts exists" "test -f src/shared/terminal-types.ts"
  run_check "R-L1-01: metrics-types.ts exists" "test -f src/shared/metrics-types.ts"
  run_check "R-L1-01: network-types.ts exists" "test -f src/shared/network-types.ts"
  run_check "R-L1-01: settings-types.ts exists" "test -f src/shared/settings-types.ts"
  run_check "R-L1-01-N1: no unknown in preload" "! grep -q 'unknown' src/preload/index.ts"

  # R-L1-02: PTY Manager
  run_check "R-L1-02: pty-manager.ts exists" "test -f src/main/pty-manager.ts"
  run_check "R-L1-02: PtyManager unit tests" "pnpm test -- --grep 'PtyManager' --reporter=dot 2>&1 | grep -q 'pass'"

  # R-L1-03: Frame Coalescing
  run_check "R-L1-03: frame-buffer.ts exists" "test -f src/main/frame-buffer.ts"
  run_check "R-L1-03: FrameBuffer unit tests" "pnpm test -- --grep 'FrameBuffer' --reporter=dot 2>&1 | grep -q 'pass'"

  # R-L1-04: IPC Handlers
  run_check "R-L1-04: IPC handler registration" "grep -q 'ipcMain.handle.*pty:create' src/main/index.ts"

  # R-L1-05: Typed preload
  run_check "R-L1-05: preload imports shared types" "grep -q 'from.*shared' src/preload/index.ts"

  # R-L1-06: TerminalView
  run_check "R-L1-06: TerminalView exists" "test -f src/renderer/components/Terminal/TerminalView.tsx"

  # R-L1-07: E2E wiring
  run_check "R-L1-07: Terminal e2e tests exist" "test -f tests/e2e/terminal.e2e.ts"

  # Typecheck
  run_check "Typecheck" "pnpm typecheck"
}

# --- Layer 2: Shell & Layout ---
verify_l2() {
  echo "=== Layer 2: Shell & Layout ==="

  # R-L2-01: Store
  run_check "R-L2-01: store/index.ts exists" "test -f src/renderer/store/index.ts"
  run_check "R-L2-01: terminal-slice.ts" "test -f src/renderer/store/terminal-slice.ts"
  run_check "R-L2-01: layout-slice.ts" "test -f src/renderer/store/layout-slice.ts"
  run_check "R-L2-01: panel-slice.ts" "test -f src/renderer/store/panel-slice.ts"
  run_check "R-L2-01: settings-slice.ts" "test -f src/renderer/store/settings-slice.ts"

  # R-L2-02~03: Tabs & Panes
  run_check "R-L2-02: Tab e2e tests" "test -f tests/e2e/tabs.e2e.ts"
  run_check "R-L2-03: Pane e2e tests" "test -f tests/e2e/panes.e2e.ts"

  # R-L2-04: SplitContainer
  run_check "R-L2-04: SplitContainer exists" "test -d src/renderer/components/SplitContainer"

  # R-L2-05~07: UI Components
  run_check "R-L2-05: TitleBar exists" "test -d src/renderer/components/TitleBar"
  run_check "R-L2-06: TabBar exists" "test -d src/renderer/components/TabBar"
  run_check "R-L2-07: StatusBar exists" "test -d src/renderer/components/StatusBar"

  # R-L2-08: Keyboard
  run_check "R-L2-08: Keyboard e2e tests" "test -f tests/e2e/keyboard.e2e.ts"
}

# --- Layer 3: Side Panels ---
verify_l3() {
  echo "=== Layer 3: Side Panels ==="

  # R-L3-01: Rail
  run_check "R-L3-01: Rail exists" "test -d src/renderer/components/Rail"

  # R-L3-02: Visibility hook
  run_check "R-L3-02: useVisibilityLifecycle" "test -f src/renderer/hooks/useVisibilityLifecycle.ts"

  # R-L3-03: FilesPanel
  run_check "R-L3-03: FilesPanel exists" "test -d src/renderer/components/panels/FilesPanel"
  run_check "R-L3-03: filesystem.ts" "test -f src/main/filesystem.ts"

  # R-L3-04: File Preview
  run_check "R-L3-04: file-protocol.ts" "test -f src/main/file-protocol.ts"

  # R-L3-05: StatusPanel
  run_check "R-L3-05: StatusPanel exists" "test -d src/renderer/components/panels/StatusPanel"
  run_check "R-L3-05: metrics.ts" "test -f src/main/metrics.ts"

  # R-L3-06: NetworkPanel
  run_check "R-L3-06: NetworkPanel exists" "test -d src/renderer/components/panels/NetworkPanel"
  run_check "R-L3-06: network.ts" "test -f src/main/network.ts"

  # R-L3-07~08: Settings
  run_check "R-L3-07: SettingsPanel exists" "test -d src/renderer/components/panels/SettingsPanel"
  run_check "R-L3-08: settings.ts" "test -f src/main/settings.ts"
}

# --- Layer 4: Polish ---
verify_l4() {
  echo "=== Layer 4: Polish ==="

  run_check "R-L4-01: FloatingPanel" "test -d src/renderer/components/FloatingPanel"
  run_check "R-L4-02: ContextMenu" "test -d src/renderer/components/ContextMenu"
  run_check "R-L4-03: CommandPalette" "test -d src/renderer/components/CommandPalette"
  run_check "R-L4-04: FindBar" "test -d src/renderer/components/FindBar"
  run_check "R-L4-05: Floating e2e" "test -f tests/e2e/floating.e2e.ts"
}

# --- Run ---
case "$LAYER" in
  l1) verify_l1 ;;
  l2) verify_l2 ;;
  l3) verify_l3 ;;
  l4) verify_l4 ;;
  all)
    verify_l1
    verify_l2
    verify_l3
    verify_l4
    ;;
  *)
    echo "Usage: $0 [l1|l2|l3|l4|all]"
    exit 1
    ;;
esac

echo ""
echo "=== Summary ==="
echo "PASS: $PASS  FAIL: $FAIL  SKIP: $SKIP"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
