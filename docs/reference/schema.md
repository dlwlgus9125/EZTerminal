---
doc_type: reference
authority: canonical
status: active
---

# Schema

Data models, Zustand store shapes, and IPC message types for EZTerminal.

## Layout Types

```typescript
type LayoutNode = LeafNode | SplitNode;

interface LeafNode {
  type: 'leaf';
  paneId: string; // UUID
}

interface SplitNode {
  type: 'split';
  orientation: 'horizontal' | 'vertical';
  ratio: number; // 0.0–1.0, first child share
  first: LayoutNode;
  second: LayoutNode;
}
```

Max depth: 3 (max 4 panes). `null` root = empty tab.

## Tab State

```typescript
interface TabState {
  id: string;           // UUID
  title: string;        // shell name or custom
  layout: LayoutNode | null;
  activePaneId: string | null;
  zoomedPaneId: string | null;
}
```

## Pane State

```typescript
interface PaneState {
  id: string;           // UUID, matches LeafNode.paneId
  sessionId: string;    // PTY session UUID from PtyManager
  shellPath: string;    // resolved shell executable path
}
```

## Zustand Store Slices

### tabSlice

```typescript
interface TabSlice {
  tabs: TabState[];
  activeTabId: string;
  createTab(): void;
  closeTab(tabId: string): void;
  activateTab(tabId: string): void;
  splitPane(paneId: string, orientation: 'horizontal' | 'vertical'): void;
  closePane(paneId: string): void;
  focusPane(paneId: string): void;
  toggleZoom(): void;
  resizeSplit(nodeId: string, ratio: number): void;
}
```

### settingsSlice

```typescript
interface SettingsSlice {
  settings: Settings;
  loadSettings(): Promise<void>;
  saveSettings(settings: Settings): Promise<void>;
}
```

### uiSlice

```typescript
interface UiSlice {
  activePanel: 'status' | 'network' | 'settings' | null;
  togglePanel(panel: 'status' | 'network' | 'settings'): void;
}
```

### metricsSlice

```typescript
interface MetricsSlice {
  cpu: CpuMetric | null;
  memory: MemoryMetric | null;
  disk: DiskMetric[];
  processes: ProcessInfo[];
  gpu: GpuMetric | null;
  cpuHistory: TimeSeriesPoint[];   // 60s window
  memoryHistory: TimeSeriesPoint[]; // 60s window
  update(payload: MetricPayload): void;
}
```

### networkSlice

```typescript
interface NetworkSlice {
  traffic: TrafficPoint[];      // 60s window
  packets: Packet[];            // ring buffer view
  connections: Connection[];
  npcapAvailable: boolean;
  selectedPacketIndex: number | null;
  activeInterface: string | null;
  addTraffic(point: TrafficPoint): void;
  addPackets(packets: Packet[]): void;
  setConnections(conns: Connection[]): void;
  selectPacket(index: number | null): void;
  setInterface(iface: string | null): void;
}
```

## IPC Message Types

### MetricPayload

```typescript
interface MetricPayload {
  cpu: CpuMetric;
  memory: MemoryMetric;
  disk: DiskMetric[];
  processes: ProcessInfo[];
  gpu: GpuMetric | null;
  timestamp: number;
}

interface CpuMetric {
  usage: number;          // 0–100
  model: string;
  cores: number;
}

interface MemoryMetric {
  used: number;           // bytes
  total: number;          // bytes
  usage: number;          // 0–100
}

interface DiskMetric {
  name: string;           // drive letter or mount
  used: number;           // bytes
  total: number;          // bytes
  usage: number;          // 0–100
  isNetwork: boolean;
}

interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;            // 0–100
  memory: number;         // 0–100
}

interface GpuMetric {
  model: string;
  utilization: number;    // 0–100
  temperature: number;    // celsius
  vramUsed: number;       // bytes
  vramTotal: number;      // bytes
}
```

### TrafficPoint

```typescript
interface TrafficPoint {
  timestamp: number;
  interface: string;
  rxBytesPerSec: number;
  txBytesPerSec: number;
}
```

### Packet

```typescript
interface Packet {
  timestamp: number;
  srcIp: string;
  dstIp: string;
  protocol: 'TCP' | 'UDP' | 'ICMP' | 'Other';
  size: number;           // bytes
  raw: Uint8Array;        // for hex dump
}
```

### Connection

```typescript
interface Connection {
  pid: number;
  processName: string;
  protocol: 'TCP' | 'UDP';
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  state: string;          // ESTABLISHED, LISTEN, etc.
}
```

### TimeSeriesPoint

```typescript
interface TimeSeriesPoint {
  timestamp: number;
  value: number;
}
```

## Settings

```typescript
interface Settings {
  version: number;                   // schema version for migration
  shell: {
    path: string;                    // empty = OS default detection
  };
  font: {
    family: string;                  // default: 'Consolas'
    size: number;                    // default: 14
  };
  colorScheme: string;               // default: 'dark'
  monitoring: {
    cpuInterval: number;             // seconds, default: 1, min: 1
    diskInterval: number;            // seconds, default: 5, min: 1
    processInterval: number;         // seconds, default: 5, min: 1
    packetBufferSize: number;        // default: 1000, min: 100
  };
}
```
