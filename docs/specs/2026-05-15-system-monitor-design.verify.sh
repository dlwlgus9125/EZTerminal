#!/usr/bin/env bash
set -euo pipefail

echo "=== Spec 2: System Monitor Design Verification ==="

echo "[R1] Metrics start"
pnpm test -- --run --grep "metrics-start"

echo "[R1] Metrics stop"
pnpm test -- --run --grep "metrics-stop"

echo "[R1] Metrics dedupe"
pnpm test -- --run --grep "metrics-dedupe"

echo "[R2] Process list"
pnpm test -- --run --grep "process-list"

echo "[R3] GPU metrics"
pnpm test -- --run --grep "gpu-metrics"

echo "[R3] GPU null"
pnpm test -- --run --grep "gpu-null"

echo "[R4] CPU panel"
pnpm test -- --run --grep "cpu-panel"

echo "[R4] CPU history window"
pnpm test -- --run --grep "cpu-history-window"

echo "[R5] Memory panel"
pnpm test -- --run --grep "memory-panel"

echo "[R6] Disk panel"
pnpm test -- --run --grep "disk-panel"

echo "[R6] Disk danger"
pnpm test -- --run --grep "disk-danger"

echo "[R7] Chart render"
pnpm test -- --run --grep "chart-render"

echo "[R7] Chart empty"
pnpm test -- --run --grep "chart-empty"

echo "[R7] Chart single"
pnpm test -- --run --grep "chart-single"

echo "[R8] Visibility start"
pnpm test -- --run --grep "visibility-start"

echo "[R8] Visibility stop"
pnpm test -- --run --grep "visibility-stop"

echo "[R8] Visibility minimize"
pnpm test -- --run --grep "visibility-minimize"

echo "[R8] Visibility debounce"
pnpm test -- --run --grep "visibility-debounce"

echo "=== All Spec 2 verifications passed ==="
