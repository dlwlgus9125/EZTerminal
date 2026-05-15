#!/usr/bin/env bash
set -euo pipefail

echo "=== Spec 3: Network + Settings Design Verification ==="

echo "[R1] Traffic start"
pnpm test -- --run --grep "traffic-start"

echo "[R1] Traffic interface"
pnpm test -- --run --grep "traffic-interface"

echo "[R1] Traffic fallback"
pnpm test -- --run --grep "traffic-fallback"

echo "[R2] Capture start"
pnpm test -- --run --grep "capture-start"

echo "[R2] Capture ring buffer"
pnpm test -- --run --grep "capture-ring-buffer"

echo "[R2] Capture stop"
pnpm test -- --run --grep "capture-stop"

echo "[R3] Npcap missing"
pnpm test -- --run --grep "npcap-missing"

echo "[R3] Npcap present"
pnpm test -- --run --grep "npcap-present"

echo "[R3] Npcap fallback"
pnpm test -- --run --grep "npcap-fallback"

echo "[R4] Packet list render"
pnpm test -- --run --grep "packet-list-render"

echo "[R4] Packet filter"
pnpm test -- --run --grep "packet-filter"

echo "[R4] Packet select"
pnpm test -- --run --grep "packet-select"

echo "[R5] Hexdump render"
pnpm test -- --run --grep "hexdump-render"

echo "[R5] Hexdump nonprint"
pnpm test -- --run --grep "hexdump-nonprint"

echo "[R6] Connections render"
pnpm test -- --run --grep "connections-render"

echo "[R6] Connections stop"
pnpm test -- --run --grep "connections-stop"

echo "[R7] Settings interval"
pnpm test -- --run --grep "settings-interval"

echo "[R7] Settings buffer size"
pnpm test -- --run --grep "settings-buffer-size"

echo "[R8] Network visibility start"
pnpm test -- --run --grep "network-visibility-start"

echo "[R8] Network visibility stop"
pnpm test -- --run --grep "network-visibility-stop"

echo "[R8] Network shutdown"
pnpm test -- --run --grep "network-shutdown"

echo "=== All Spec 3 verifications passed ==="
