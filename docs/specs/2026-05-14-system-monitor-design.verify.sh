#!/usr/bin/env bash
# Verify script for Spec 2: System Monitor
# Generated: 2026-05-14
set -euo pipefail

echo "=== Spec 2: System Monitor Verification ==="

# R1: Metrics service
echo "[R1] Metrics service tests..."
pnpm test -- --run --grep "metrics-start|metrics-stop|metrics-no-duplicate"

# R2: Process list
echo "[R2] Process list tests..."
pnpm test -- --run --grep "process-list-bounded|process-list-sort"

# R3: GPU metrics
echo "[R3] GPU tests..."
pnpm test -- --run --grep "gpu-nvidia|gpu-null-fallback"

# R4: CPU panel
echo "[R4] CPU panel tests..."
pnpm test -- --run --grep "cpu-panel-render|cpu-panel-window"

# R5: Memory panel
echo "[R5] Memory panel tests..."
pnpm test -- --run --grep "memory-panel-render"

# R6: Disk panel
echo "[R6] Disk panel tests..."
pnpm test -- --run --grep "disk-panel-render|disk-panel-danger"

# R7: Chart component
echo "[R7] Chart tests..."
pnpm test -- --run --grep "chart-render|chart-empty"

# R8: Visibility lifecycle
echo "[R8] Visibility lifecycle tests..."
pnpm test -- --run --grep "visibility-start-on-show|visibility-stop-on-minimize|visibility-floating-close"

echo "=== Spec 2 verification complete ==="
