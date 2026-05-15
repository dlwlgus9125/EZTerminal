---
doc_type: spec
authority: derived
status: approved
id: spec-3
date: 2026-05-15
depends_on: spec-1
---

# Network Monitor + Settings Extension Design

Network traffic graph, packet capture, hex dump, connection table, Npcap graceful degradation, monitoring settings extension.

## Architecture Baseline

Inherits from spec-1. Additional modules:

| Module | Responsibility | Public Interface |
|--------|---------------|------------------|
| main/network | Traffic stats, packet capture, connection query | NetworkService: startTraffic/stopTraffic/startCapture/stopCapture/getConnections/isNpcapAvailable |
| renderer/stores (networkSlice) | Traffic, packet, connection state | addTraffic/addPackets/setConnections/selectPacket/setInterface |
| renderer/components (NetworkPanel) | Network rail panel UI | TrafficChart, PacketList, HexDump, ConnectionTable |

**Npcap graceful degradation (ADR-007):** When Npcap absent, packet capture disabled, traffic falls back to systeminformation network stats. Connection table works via netstat (independent of Npcap).

**IPC channels (8):**
| Channel | Direction | Type | Signature |
|---------|-----------|------|-----------|
| network:startTraffic | R->M | send | `(interfaceName?: string) => void` |
| network:stopTraffic | R->M | send | `() => void` |
| network:startCapture | R->M | invoke | `(interfaceName: string) => void` |
| network:stopCapture | R->M | invoke | `() => void` |
| network:getConnections | R->M | invoke | `() => Connection[]` |
| network:isNpcapAvailable | R->M | invoke | `() => boolean` |
| network:traffic | M->R | send | `(point: TrafficPoint) => void` |
| network:packets | M->R | send | `(packets: Packet[]) => void` |

Traffic (statistics) and capture (packets) are independent systems. Traffic uses systeminformation (no Npcap needed). Capture requires Npcap via cap library.

## ASR Ledger

| ID | Quality Attribute | Target | Design Impact | Verify |
|----|-------------------|--------|---------------|--------|
| ASR-3 | Performance | monitoring-update < 100ms | Debounced traffic push, bounded ring buffer | `pnpm test -- --run --grep "network-latency"` |
| ASR-5 | Reliability | Zero handle leaks | cap handle released on stopCapture, shutdown, crash recovery | `pnpm test -- --run --grep "cap-handle-leak"` |

## Option Matrix

| Decision | Option A (Selected) | Option B (Rejected) | Tradeoff |
|----------|-------------------|-------------------|----------|
| Capture library | cap 0.3 (Npcap) | raw-socket / pcap | raw-socket: limited protocol support. pcap: stale maintenance. cap: active, TS types, Windows standard |
| Npcap handling | Graceful degradation (ADR-007) | Require Npcap | Require: blocks non-network-focused users. Graceful: app functional without Npcap |
| Traffic fallback | systeminformation networkStats | No traffic without Npcap | No fallback: traffic graph blank when no Npcap. Fallback: useful aggregate stats always available |
| Hex dump format | 8 bytes/line | 16 bytes/line (Wireshark style) | 16: standard but needs >300px panel width. 8: fits 300px panel |
| Connections source | netstat-based (systeminformation) | cap-based parsing | cap-based: couples to Npcap. netstat: independent, standard |
| Traffic/capture channels | Separated (startTraffic/startCapture) | Unified (single start) | Unified: simpler API but can't start traffic without Npcap. Separated: independent control |

## Lifecycle And Operations

- **Startup:** NetworkService instance created at stage 4. Npcap detected via cap import try-catch. Idle until panel visible.
- **Panel open:** useVisibilityLifecycle sends network:startTraffic -> traffic stats begin. Capture started separately by user action.
- **Panel close:** network:stopTraffic sent. Active capture also stopped (network:stopCapture).
- **Minimize:** traffic and capture stopped via visibility lifecycle.
- **Shutdown:** NetworkService.stop() releases cap handle, stops all intervals.
- **Npcap missing:** isNpcapAvailable returns false, capture UI disabled, traffic falls back to systeminformation.
- **Recovery:** cap session error: handle released, capture stopped, error logged. systeminformation fallback active for traffic.
- **Deployment:** Governed by Spec-1 (Electron Forge make)
- **Migration:** Governed by Spec-1 (settings.json versioned)
- **Observability:** console logging per Spec-1. Cap handle lifecycle logged for leak detection.
- **Ownership:** Governed by Spec-1 (single developer)

## Quality Budgets

| Category | Budget | Risk if None |
|----------|--------|-------------|
| Performance | monitoring-update < 100ms, ring buffer bounded (configurable PacketBufferSize) | — |
| Reliability | cap handle always released on stop/shutdown/crash | — |
| Security | Npcap requires admin privilege, documented in UI | — |
| Cost | none declared | Governed by Spec-1 (single developer, no cloud cost) |
| Maintainability | cap API may change before v1.0, isolated in NetworkService | — |

## Wiring Map

| ID | Aspect | Value |
|----|--------|-------|
| WM-REG6 | Registration | Network IPC handlers in `src/main/ipc/network.ts`: network:startTraffic(on), network:stopTraffic(on), network:startCapture(invoke), network:stopCapture(invoke), network:getConnections(invoke), network:isNpcapAvailable(invoke), network:traffic(send), network:packets(send). Visibility lifecycle for traffic. **Probe: runtime-load** |
| WM-REG7 | Registration | Settings schema extension in `src/main/settings/schema.ts`: monitoring intervals, PacketBufferSize. Atomic persistence in `src/main/settings/service.ts`. **Probe: runtime-load** |
| WM-DF7 | Data flow | Rail Network click(void) -> uiSlice.activePanel='network'(string) -> useVisibilityLifecycle(void) -> electronAPI.network.startTraffic(interfaceName?:string)(void) -> preload send('network:startTraffic') -> ipcMain.on('network:startTraffic') -> NetworkService.startTraffic(interfaceName?:string)(void) -> systeminformation.networkStats()(NetworkStats) or cap stats -> mainWindow.webContents.send('network:traffic', point:TrafficPoint) -> preload on('network:traffic') -> networkSlice.addTraffic(point:TrafficPoint) -> TrafficChart re-render |
| WM-DF8 | Data flow | Capture button(string) -> electronAPI.network.startCapture(iface:string)(void) -> preload invoke('network:startCapture') -> ipcMain.handle('network:startCapture') -> NetworkService.startCapture(iface:string)(void) -> cap.open(iface)(cap.Session) -> ring buffer(Packet[]) -> mainWindow.webContents.send('network:packets', packets:Packet[]) -> preload on('network:packets') -> networkSlice.addPackets(packets:Packet[]) -> PacketList re-render |
| WM-DF9 | Data flow | Connections expander click(void) -> electronAPI.network.getConnections()(Connection[]) -> preload invoke('network:getConnections') -> ipcMain.handle('network:getConnections') -> systeminformation.networkConnections()(Connection[]) -> ConnectionTable render |
| WM-DF10 | Data flow | Settings monitoring change(Settings) -> electronAPI.settings.save(settings:Settings)(void) -> preload invoke('settings:save') -> ipcMain.handle('settings:save') -> SettingsService.save(settings:Settings) -> MetricsService/NetworkService detect new intervals on next cycle |
| WM-C23 | Contract | `NetworkService.startTraffic(interfaceName?: string): void` |
| WM-C24 | Contract | `NetworkService.stopTraffic(): void` |
| WM-C25 | Contract | `NetworkService.startCapture(interfaceName: string): void` |
| WM-C26 | Contract | `NetworkService.stopCapture(): void` |
| WM-C27 | Contract | `NetworkService.getConnections(): Promise<Connection[]>` |
| WM-C28 | Contract | `NetworkService.isNpcapAvailable(): boolean` |
| WM-C29 | Contract | `ElectronAPI.network.startTraffic(interfaceName?: string): void` |
| WM-C30 | Contract | `ElectronAPI.network.stopTraffic(): void` |
| WM-C31 | Contract | `ElectronAPI.network.startCapture(interfaceName: string): Promise<void>` |
| WM-C32 | Contract | `ElectronAPI.network.stopCapture(): Promise<void>` |
| WM-C33 | Contract | `ElectronAPI.network.getConnections(): Promise<Connection[]>` |
| WM-C34 | Contract | `ElectronAPI.network.isNpcapAvailable(): Promise<boolean>` |
| WM-C35 | Contract | `ElectronAPI.network.onTraffic(cb: (point: TrafficPoint) => void): () => void` |
| WM-C36 | Contract | `ElectronAPI.network.onPackets(cb: (packets: Packet[]) => void): () => void` |

## Initialization Order

Full 9-stage order defined in Spec-1. Network-relevant stages:

| Stage | Module | Prerequisite | Readiness Signal |
|-------|--------|-------------|------------------|
| 1 | main/pty | none | PtyManager instance created |
| 2 | main/settings | none | Settings loaded from file (or defaults) |
| 3 | main/metrics | none | MetricsService instance created (idle) |
| 4 | **main/network** | none | NetworkService created, Npcap detect complete (boolean cached) |
| 5 | main/ipc | main/pty, main/settings, main/metrics, main/network | All IPC handlers registered |
| 6 | main/window | main/ipc | BrowserWindow ready-to-show |
| 7 | preload/api | main/window | contextBridge complete |
| 8 | **renderer/stores (networkSlice)** | preload/api | Zustand stores initialized, subscribed to network:traffic/packets |
| 9 | renderer/terminal | renderer/stores | First TerminalView mounted |
| — | **NetworkPanel** | user opens panel | isNpcapAvailable called, startTraffic sent |
| — | **PacketCaptureService** | user clicks capture | startCapture invoked (lazy) |

## Decision Log

| # | Decision | ADR Required | Rationale |
|---|----------|-------------|-----------|
| 1 | cap over raw-socket | No | Library choice, swappable |
| 2 | Npcap graceful degradation | Yes: ADR-007 | Privilege dependency, two data-source paths, surprising |
| 3 | 8 bytes/line hex dump | No | Layout choice, trivially changeable |
| 4 | netstat for connections | No | Standard approach, no special dependency |
| 5 | Visibility lifecycle | Yes: ADR-006 | Cross-spec pattern |
| 6 | Traffic/capture channel separation | No | API design, easily changed to unified |

## Requirements

### R1: Traffic Graph

**ASR:** ASR-3
**Input:** NetworkPanel becomes visible
**Behavior:** network:startTraffic sends to main. NetworkService collects RX/TX bytes-per-second per interface via systeminformation.networkStats() (or cap stats when Npcap available and active). Interface selector: physical, wireless, loopback, all. TrafficChart renders 60s history (same Canvas 2D component as metrics). network:stopTraffic on panel hide.
**Output:** Live traffic chart in NetworkPanel
**Impact scope:**
- main/network: traffic collection
- renderer/components: TrafficChart, InterfaceSelector
**Acceptance criteria:**
- [ ] Given: NetworkPanel visible
      When: network:startTraffic sent
      Then: TrafficPoints flow via network:traffic, chart renders RX/TX
      Verify: `pnpm test -- --run --grep "traffic-start"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Traffic flowing
      When: Interface changed in selector
      Then: Traffic filtered to selected interface
      Verify: `pnpm test -- --run --grep "traffic-interface"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Npcap not installed
      When: Traffic collected
      Then: systeminformation fallback provides aggregate stats
      Verify: `pnpm test -- --run --grep "traffic-fallback"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- No network interfaces: empty chart, no error

### R2: Packet Capture

**ASR:** ASR-5
**Input:** User clicks capture start button
**Behavior:** network:startCapture(interfaceName) invoked. NetworkService opens cap session on interface. Packets parsed defensively (IP/TCP/UDP/ICMP headers, raw payload). Ring buffer with configurable PacketBufferSize (default 1000). Oldest packets dropped when buffer full. network:stopCapture invoked to stop. Buffer retained after stop for inspection.
**Output:** Packet[] in networkSlice via network:packets
**Impact scope:**
- main/network: capture session
- renderer/stores: networkSlice.packets
**Acceptance criteria:**
- [ ] Given: Npcap installed, NetworkPanel open
      When: Capture started on interface
      Then: Packets flow via network:packets, ring buffer fills
      Verify: `pnpm test -- --run --grep "capture-start"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Ring buffer at capacity (1000)
      When: New packet arrives
      Then: Oldest packet dropped, buffer size maintained at 1000
      Verify: `pnpm test -- --run --grep "capture-ring-buffer"`
      Verify-type: pure
      Automatable: true
- [ ] Given: Capture active
      When: Capture stopped
      Then: cap session closed, buffer retained for viewing
      Verify: `pnpm test -- --run --grep "capture-stop"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Malformed packet: logged, skipped, not added to buffer
- Cap handle leak: handle tracked, force-closed on shutdown

### R3: Npcap Missing Handling

**ASR:** none
**Input:** App startup / NetworkPanel mount
**Behavior:** NetworkService detects Npcap at stage 4 via cap import try-catch. network:isNpcapAvailable invoke channel returns cached boolean. When missing: capture UI disabled (button grayed), "Npcap required for packet capture" notice with download link. Traffic falls back to systeminformation. Connections work (netstat-based). When present: full capture UI enabled.
**Output:** UI adapted to Npcap presence
**Impact scope:**
- main/network: Npcap detection
- renderer/components: NetworkPanel conditional UI
**Acceptance criteria:**
- [ ] Given: Npcap not installed
      When: NetworkPanel opens, isNpcapAvailable called
      Then: Returns false, capture button disabled, notice shown
      Verify: `pnpm test -- --run --grep "npcap-missing"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Npcap installed
      When: NetworkPanel opens, isNpcapAvailable called
      Then: Returns true, full capture UI enabled
      Verify: `pnpm test -- --run --grep "npcap-present"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Npcap not installed
      When: Traffic started
      Then: systeminformation fallback active, connections work
      Verify: `pnpm test -- --run --grep "npcap-fallback"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Npcap installed after app start: requires app restart to detect (cached at stage 4)

### R4: Packet List

**ASR:** none
**Input:** Packets in networkSlice
**Behavior:** Table columns: timestamp (HH:MM:SS.mmm), source IP, dest IP, protocol (TCP/UDP/ICMP/Other), size (bytes). Protocol chip filters: click to toggle TCP/UDP/ICMP/Other. Click row selects packet and shows hex dump below.
**Output:** Filtered packet list with selection
**Impact scope:**
- renderer/components: PacketList
**Acceptance criteria:**
- [ ] Given: 50 packets captured
      When: PacketList rendered
      Then: All 50 rows displayed with correct columns
      Verify: `pnpm test -- --run --grep "packet-list-render"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Mixed protocol packets
      When: TCP filter chip toggled off
      Then: TCP packets hidden, others visible
      Verify: `pnpm test -- --run --grep "packet-filter"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Packet list displayed
      When: Row clicked
      Then: selectedPacketIndex updated, HexDump shows selected packet
      Verify: `pnpm test -- --run --grep "packet-select"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Empty packet list: "No packets captured" message

### R5: Hex Dump

**ASR:** none
**Input:** Selected packet from PacketList
**Behavior:** Display: 8 bytes per line. Each line: offset (hex), 8 hex bytes (space-separated), ASCII representation (. for non-printable, 0x20-0x7E range). Scrollable container for large packets.
**Output:** Hex + ASCII view of packet
**Impact scope:**
- renderer/components: HexDump
**Acceptance criteria:**
- [ ] Given: 32-byte packet selected
      When: HexDump rendered
      Then: 4 lines displayed (8 bytes each), offset + hex + ASCII
      Verify: `pnpm test -- --run --grep "hexdump-render"`
      Verify-type: pure
      Automatable: true
- [ ] Given: Packet with non-printable bytes (0x00, 0xFF)
      When: HexDump rendered
      Then: Non-printable shown as . in ASCII column
      Verify: `pnpm test -- --run --grep "hexdump-nonprint"`
      Verify-type: pure
      Automatable: true
**Edge cases:**
- Packet smaller than 8 bytes: single line, padded with spaces
- No packet selected: HexDump shows placeholder

### R6: Connection Table

**ASR:** none
**Input:** Connections expander opened in NetworkPanel
**Behavior:** network:getConnections invoked. Returns active connections: PID, process name, protocol (TCP/UDP), local address:port, remote address:port, state. Expander open triggers collection, close stops. netstat-based via systeminformation (independent of Npcap).
**Output:** Connection table
**Impact scope:**
- main/network: connection query
- renderer/components: ConnectionTable
**Acceptance criteria:**
- [ ] Given: NetworkPanel open
      When: Connections expander opened
      Then: Connection table shows PID, name, proto, local, remote, state
      Verify: `pnpm test -- --run --grep "connections-render"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Connections expander open
      When: Expander collapsed
      Then: Collection stops
      Verify: `pnpm test -- --run --grep "connections-stop"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- No active connections: empty table with message
- Process with no name: shows PID only

### R7: Monitoring Settings Items

**ASR:** none
**Input:** Settings panel monitoring section
**Behavior:** Editable fields: CPU interval (seconds, min 1), disk interval (seconds, min 1), process interval (seconds, min 1), PacketBufferSize (default 1000, min 100). Changes saved via settings:save. Running MetricsService/NetworkService pick up new intervals on next cycle (no restart needed).
**Output:** Updated monitoring configuration
**Impact scope:**
- renderer/components: SettingsPanel (monitoring section)
- main/settings: schema extension
- main/metrics: interval change detection
- main/network: buffer size change
**Acceptance criteria:**
- [ ] Given: Monitoring settings displayed
      When: CPU interval changed from 1s to 2s and saved
      Then: MetricsService uses 2s interval on next cycle
      Verify: `pnpm test -- --run --grep "settings-interval"`
      Verify-type: lib
      Automatable: true
- [ ] Given: PacketBufferSize set to 500
      When: Capture runs
      Then: Ring buffer capped at 500 packets
      Verify: `pnpm test -- --run --grep "settings-buffer-size"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Value below minimum: clamped to minimum (1s for intervals, 100 for buffer)

### R8: Network Visibility Lifecycle

**ASR:** ASR-5
**Input:** NetworkPanel visibility changes
**Behavior:** Panel open -> network:startTraffic sent. Panel close/switch -> network:stopTraffic + network:stopCapture sent. App minimize -> all stopped. Floating NetworkPanel minimize -> stopped for that instance. App shutdown -> stopTraffic + stopCapture, cap handle released. 200ms debounce on rapid visibility changes.
**Output:** Network collectors started/stopped matching visibility
**Impact scope:**
- renderer/hooks: useVisibilityLifecycle
- main/network: start/stop
**Acceptance criteria:**
- [ ] Given: NetworkPanel closed
      When: Opened via Rail click
      Then: network:startTraffic sent, traffic begins flowing
      Verify: `pnpm test -- --run --grep "network-visibility-start"`
      Verify-type: lib
      Automatable: true
- [ ] Given: NetworkPanel open with active capture
      When: Panel closed
      Then: Both stopTraffic and stopCapture sent, cap handle released
      Verify: `pnpm test -- --run --grep "network-visibility-stop"`
      Verify-type: lib
      Automatable: true
- [ ] Given: App running with NetworkPanel open
      When: App shutdown
      Then: Traffic stopped, capture stopped, cap handle released before quit
      Verify: `pnpm test -- --run --grep "network-shutdown"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Rapid panel toggle: 200ms debounce prevents start/stop churn
