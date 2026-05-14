#!/usr/bin/env bash
# Verify script for Spec 3: Network + Settings Extension
# Generated: 2026-05-14
set -euo pipefail

echo "=== Spec 3: Network + Settings Verification ==="

# R1: Traffic graph
echo "[R1] Traffic tests..."
pnpm test -- --run --grep "traffic-chart-render|traffic-interface-select|traffic-npcap-fallback"

# R2: Packet capture
echo "[R2] Capture tests..."
pnpm test -- --run --grep "capture-start|capture-stop|capture-ring-buffer"

# R3: Npcap handling
echo "[R3] Npcap detection tests..."
pnpm test -- --run --grep "npcap-missing-graceful|npcap-present"

# R4: Packet list
echo "[R4] Packet list tests..."
pnpm test -- --run --grep "packet-list-render|packet-list-filter|packet-list-select"

# R5: Hex dump
echo "[R5] Hex dump tests..."
pnpm test -- --run --grep "hexdump-render|hexdump-nonprintable"

# R6: Connection table
echo "[R6] Connection table tests..."
pnpm test -- --run --grep "connection-expander-collapsed|connection-table-render|connection-expander-stop"

# R7: Monitoring settings
echo "[R7] Monitoring settings tests..."
pnpm test -- --run --grep "settings-metric-interval|settings-packet-buffer"

# R8: Network visibility lifecycle
echo "[R8] Network visibility tests..."
pnpm test -- --run --grep "net-visibility-start|net-visibility-stop-all|net-shutdown-cleanup"

echo "=== Spec 3 verification complete ==="
