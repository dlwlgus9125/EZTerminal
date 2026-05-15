#!/usr/bin/env bash
set -euo pipefail

echo "=== Filesystem & Scrollback Spec Verification ==="

# R1: Files Panel
echo "--- R1: Files Panel ---"
pnpm test -- --run --grep "files-panel-tree"
pnpm test -- --run --grep "files-panel-expand"
pnpm test -- --run --grep "files-panel-addressbar"
pnpm test -- --run --grep "files-panel-virtual-scroll"

# R2: CWD Detection
echo "--- R2: CWD Detection ---"
pnpm test -- --run --grep "cwd-osc7"
pnpm test -- --run --grep "cwd-fallback"
pnpm test -- --run --grep "cwd-pane-switch"
pnpm test -- --run --grep "cwd-fallback-latency"

# R3: File Preview
echo "--- R3: File Preview ---"
pnpm test -- --run --grep "preview-text"
pnpm test -- --run --grep "preview-truncated"
pnpm test -- --run --grep "preview-image"
pnpm test -- --run --grep "html-preview-sandbox"
pnpm test -- --run --grep "preview-binary"

# R4: File Context Menu
echo "--- R4: File Context Menu ---"
pnpm test -- --run --grep "file-context-copy-path"
pnpm test -- --run --grep "file-context-paste-terminal"
pnpm test:e2e -- --grep "file-context-open-os"

# R5: Directory Watching
echo "--- R5: Directory Watching ---"
pnpm test -- --run --grep "watch-file-add"
pnpm test -- --run --grep "watch-file-remove"
pnpm test -- --run --grep "watch-reopen-fresh"
pnpm test -- --run --grep "watch-visibility-minimize"

# R6: Save Scrollback
echo "--- R6: Save Scrollback ---"
pnpm test:e2e -- --grep "scrollback-save-dialog"
pnpm test -- --run --grep "scrollback-save-content"
pnpm test -- --run --grep "scrollback-save-cancel"

# R7: Custom File Protocol
echo "--- R7: Custom File Protocol ---"
pnpm test -- --run --grep "protocol-image-serve"
pnpm test -- --run --grep "protocol-extension-deny"
pnpm test -- --run --grep "protocol-traversal-deny"
pnpm test -- --run --grep "protocol-html-serve"

# R8: Preload API Extension
echo "--- R8: Preload API Extension ---"
pnpm test -- --run --grep "preload-fs-api"
bash -c '! grep -rE "require\(.(fs|path|child_process)" src/renderer/'

# ASR checks
echo "--- ASR Checks ---"
pnpm test -- --run --grep "readdir-perf"
pnpm test -- --run --grep "preview-perf"
pnpm test -- --run --grep "protocol-security"

echo "=== All checks complete ==="
