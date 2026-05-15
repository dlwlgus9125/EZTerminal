---
doc_type: spec
authority: derived
status: approved
id: spec-2
date: 2026-05-15
depends_on: spec-1
---

# System Monitor Design

Status panel system metrics: collection service, display panels, charts, visibility lifecycle.

## Architecture Baseline

Inherits from spec-1. Additional modules:

| Module | Responsibility | Public Interface |
|--------|---------------|------------------|
| main/metrics | systeminformation 5 collection, interval management | MetricsService: start(intervals)/stop/getData |
| renderer/stores (metricsSlice) | Metric state, history arrays | update(payload), cpuHistory[], memoryHistory[] |
| renderer/components (StatusPanel) | Status rail panel UI | CPU/Memory/Disk/Process/GPU sub-panels |
| renderer/components (TimeSeriesChart) | Canvas 2D chart | 60s history line chart |

**IPC channels (3):**
| Channel | Direction | Type | Signature |
|---------|-----------|------|-----------|
| metrics:start | R->M | send | `() => void` |
| metrics:stop | R->M | send | `() => void` |
| metrics:data | M->R | send | `(payload: MetricPayload) => void` |

Lifecycle bound to panel visibility (ADR-006). MetricsService starts idle; only collects when StatusPanel visible.

## ASR Ledger

| ID | Quality Attribute | Target | Design Impact | Verify |
|----|-------------------|--------|---------------|--------|
| ASR-3 | Performance | monitoring-update < 100ms | Debounced metric push, Zustand selectors, requestAnimationFrame chart | `pnpm test -- --run --grep "metrics-latency"` |
| ASR-5 | Reliability | Zero collector leaks | start/stop bound to panel visibility, clearInterval on stop | `pnpm test -- --run --grep "metrics-leak"` |

## Option Matrix

| Decision | Option A (Selected) | Option B (Rejected) | Tradeoff |
|----------|-------------------|-------------------|----------|
| Metrics library | systeminformation v5 | os module + custom | os: CPU/memory only. systeminformation: unified API, GPU, process list |
| Chart renderer | Canvas 2D direct | SVG/recharts library | SVG: DOM overhead at 60fps. Canvas: no DOM, direct draw, Phosphor colors |
| GPU unavailable | null fallback (hide section) | error message | Error: alarming for non-GPU systems. Null: optional enhancement hidden |
| Collector lifecycle | Visibility-bound (ADR-006) | Always-on | Always-on: CPU waste when panel hidden. Visibility: zero overhead when hidden |

## Lifecycle And Operations

- **Startup:** MetricsService instance created at stage 3 (idle, no intervals)
- **Panel open:** useVisibilityLifecycle hook sends metrics:start -> MetricsService.start(intervals) -> setInterval per metric type
- **Panel close:** useVisibilityLifecycle hook sends metrics:stop -> MetricsService.stop() -> clearInterval all
- **Minimize:** Visibility API detects, triggers stop
- **Shutdown:** MetricsService.stop() in before-quit handler, intervals cleared
- **Recovery:** systeminformation throws mid-collection: error logged, last valid payload retained, interval continues (no crash)
- **Deployment:** Governed by Spec-1 (Electron Forge make)
- **Migration:** Governed by Spec-1 (settings.json versioned)
- **Observability:** console logging per Spec-1 (structured logging deferred)
- **Ownership:** Governed by Spec-1 (single developer)

## Quality Budgets

| Category | Budget | Risk if None |
|----------|--------|-------------|
| Performance | monitoring-update < 100ms, chart render < 16ms (60fps) | — |
| Reliability | Zero interval leaks on close/quit/minimize | — |
| Security | none declared | Metrics collection reads system state only, no write operations, no privilege escalation |
| Cost | none declared | Governed by Spec-1 (single developer, no cloud cost) |
| Maintainability | systeminformation v5 stable API surface | — |

## Wiring Map

| ID | Aspect | Value |
|----|--------|-------|
| WM-REG5 | Registration | Metrics IPC handlers in `src/main/ipc/metrics.ts`: metrics:start(on), metrics:stop(on), metrics:data(send). Visibility lifecycle in `src/renderer/hooks/useVisibilityLifecycle.ts`. **Probe: runtime-load** |
| WM-DF5 | Data flow | Rail Status click(void) -> uiSlice.activePanel='status'(string) -> useVisibilityLifecycle(void) -> electronAPI.metrics.start()(void) -> preload send('metrics:start') -> ipcMain.on('metrics:start') -> MetricsService.start(intervals:MetricIntervals) -> setInterval -> systeminformation.*()(MetricPayload) -> mainWindow.webContents.send('metrics:data', payload:MetricPayload) -> preload on('metrics:data') -> metricsSlice.update(payload:MetricPayload) -> StatusPanel re-render |
| WM-DF6 | Data flow | Panel hide(void) -> useVisibilityLifecycle(void) -> electronAPI.metrics.stop()(void) -> preload send('metrics:stop') -> ipcMain.on('metrics:stop') -> MetricsService.stop()(void) -> clearInterval |
| WM-C17 | Contract | `MetricsService.start(intervals: { cpu: number, disk: number, process: number }): void` |
| WM-C18 | Contract | `MetricsService.stop(): void` |
| WM-C19 | Contract | `MetricsService.getData(): MetricPayload` |
| WM-C20 | Contract | `ElectronAPI.metrics.start(): void` |
| WM-C21 | Contract | `ElectronAPI.metrics.stop(): void` |
| WM-C22 | Contract | `ElectronAPI.metrics.onData(cb: (payload: MetricPayload) => void): () => void` |

## Initialization Order

Full 9-stage order defined in Spec-1. Metrics-relevant stages:

| Stage | Module | Prerequisite | Readiness Signal |
|-------|--------|-------------|------------------|
| 1 | main/pty | none | PtyManager instance created |
| 2 | main/settings | none | Settings loaded from file (or defaults) |
| 3 | **main/metrics** | none | MetricsService instance created (idle, no intervals) |
| 4 | main/network | none | NetworkService instance created, Npcap detected |
| 5 | main/ipc | main/pty, main/settings, main/metrics, main/network | All IPC handlers registered |
| 6 | main/window | main/ipc | BrowserWindow ready-to-show |
| 7 | preload/api | main/window | contextBridge complete |
| 8 | **renderer/stores (metricsSlice)** | preload/api | Zustand stores initialized, subscribed to metrics:data |
| 9 | renderer/terminal | renderer/stores | First TerminalView mounted |
| — | **StatusPanel** | user opens panel | metrics:start sent, data flowing |

## Decision Log

| # | Decision | ADR Required | Rationale |
|---|----------|-------------|-----------|
| 1 | systeminformation v5 | No | Library choice, swappable |
| 2 | Canvas 2D chart | No | Performance choice, reversible renderer |
| 3 | GPU null fallback | No | UX choice, trivially reversible |
| 4 | Visibility lifecycle binding | Yes: ADR-006 | Cross-spec pattern, surprising without context |

## Requirements

### R1: System Metrics Collection Service

**ASR:** ASR-3, ASR-5
**Input:** metrics:start received from renderer
**Behavior:** MetricsService starts collection intervals: CPU/memory every cpuInterval (default 1s), disk every diskInterval (default 5s), process list every processInterval (default 5s). Each interval callback: call systeminformation, push result via metrics:data. Dedupe: if already running, ignore start. Stop: clearInterval all timers.
**Output:** MetricPayload pushed via metrics:data
**Impact scope:**
- main/metrics: MetricsService
- main/ipc: metrics channels
**Acceptance criteria:**
- [ ] Given: StatusPanel becomes visible
      When: metrics:start sent
      Then: Collection intervals begin, first metrics:data within 100ms
      Verify: `pnpm test -- --run --grep "metrics-start"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Metrics collecting
      When: metrics:stop sent
      Then: All intervals cleared, no more metrics:data events
      Verify: `pnpm test -- --run --grep "metrics-stop"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Metrics already running
      When: Second metrics:start sent
      Then: Ignored, no duplicate intervals
      Verify: `pnpm test -- --run --grep "metrics-dedupe"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- systeminformation throws: error logged, last valid payload retained, interval continues

### R2: Process List

**ASR:** ASR-3
**Input:** Process collection interval fires
**Behavior:** systeminformation.processes() returns all processes. Sort by CPU% descending, take top N (default 20). Result included in MetricPayload as bounded array.
**Output:** Top N processes in MetricPayload
**Impact scope:**
- main/metrics: process collection
**Acceptance criteria:**
- [ ] Given: Metrics collecting
      When: Process interval fires
      Then: Top 20 processes returned, sorted by CPU% descending
      Verify: `pnpm test -- --run --grep "process-list"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Fewer than 20 processes: return all available

### R3: GPU Metrics

**ASR:** none
**Input:** Metrics collection active
**Behavior:** systeminformation.graphics() returns GPU info. NVIDIA prioritized if multiple GPUs. Fields: model, utilization%, temperature, VRAM used/total. If no GPU detected or API returns null, GpuMetric is null in payload.
**Output:** GpuMetric | null in MetricPayload
**Impact scope:**
- main/metrics: GPU collection
- renderer/components: GPU section in StatusPanel
**Acceptance criteria:**
- [ ] Given: System with GPU
      When: Metrics collected
      Then: GPU model, utilization, temperature, VRAM reported
      Verify: `pnpm test -- --run --grep "gpu-metrics"`
      Verify-type: lib
      Automatable: true
- [ ] Given: System without GPU (or API returns null)
      When: Metrics collected
      Then: GpuMetric is null, GPU section hidden in panel
      Verify: `pnpm test -- --run --grep "gpu-null"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Multiple GPUs: first NVIDIA, else first available

### R4: CPU Panel

**ASR:** ASR-3
**Input:** MetricPayload received in metricsSlice
**Behavior:** Display: current CPU %, CPU model, core count. TimeSeriesChart: 60-second history, 1-second data points. New data point appended; points older than 60s dropped.
**Output:** CPU panel with live chart
**Impact scope:**
- renderer/components: CpuPanel
- renderer/stores: metricsSlice.cpuHistory
**Acceptance criteria:**
- [ ] Given: StatusPanel open, metrics flowing
      When: CPU data received
      Then: Current %, model, cores displayed; chart shows history
      Verify: `pnpm test -- --run --grep "cpu-panel"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 60+ data points accumulated
      When: New point added
      Then: Oldest point dropped, 60s window maintained
      Verify: `pnpm test -- --run --grep "cpu-history-window"`
      Verify-type: pure
      Automatable: true
**Edge cases:**
- First data point: chart renders single dot, no crash

### R5: Memory Panel

**ASR:** ASR-3
**Input:** MetricPayload received
**Behavior:** Display: used GB / total GB, usage %. TimeSeriesChart: 60s history.
**Output:** Memory panel with live chart
**Impact scope:**
- renderer/components: MemoryPanel
- renderer/stores: metricsSlice.memoryHistory
**Acceptance criteria:**
- [ ] Given: StatusPanel open, metrics flowing
      When: Memory data received
      Then: Used/total GB, %, and 60s chart displayed
      Verify: `pnpm test -- --run --grep "memory-panel"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Very low memory (<100MB free): used/total display as numeric GB values, no NaN from division by near-zero

### R6: Disk Panel

**ASR:** none
**Input:** MetricPayload received
**Behavior:** Display: each drive's used/total GB with % bar. Bar color: red if usage >90%. Disk interval default 5s.
**Output:** Disk usage bars per drive
**Impact scope:**
- renderer/components: DiskPanel
**Acceptance criteria:**
- [ ] Given: Disk metrics received
      When: Rendered
      Then: Each drive shows used/total GB and % bar
      Verify: `pnpm test -- --run --grep "disk-panel"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Drive at 95% usage
      When: Rendered
      Then: Bar color is danger/red
      Verify: `pnpm test -- --run --grep "disk-danger"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Network drive: included if systeminformation reports it, marked with isNetwork flag

### R7: Chart Component (TimeSeriesChart)

**ASR:** ASR-3
**Input:** TimeSeriesPoint[] array
**Behavior:** Canvas 2D line chart. X-axis: 60s window (time). Y-axis: 0-100% (or auto-range for bytes). Phosphor green line on dark background. requestAnimationFrame for smooth rendering. Empty data array renders blank canvas (no error).
**Output:** Rendered canvas chart
**Impact scope:**
- renderer/components: TimeSeriesChart
**Acceptance criteria:**
- [ ] Given: 60 data points
      When: Chart rendered
      Then: Line chart drawn on canvas with correct scale
      Verify: `pnpm test -- --run --grep "chart-render"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Empty data array
      When: Chart rendered
      Then: Blank canvas, no error thrown
      Verify: `pnpm test -- --run --grep "chart-empty"`
      Verify-type: pure
      Automatable: true
- [ ] Given: Single data point
      When: Chart rendered
      Then: Single dot rendered, no crash
      Verify: `pnpm test -- --run --grep "chart-single"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Canvas context unavailable: logged, component renders nothing

### R8: Visibility Lifecycle

**ASR:** ASR-5
**Input:** Panel visibility changes
**Behavior:** Panel open -> metrics:start sent. Panel close/switch -> metrics:stop sent. App minimize (Page Visibility API) -> metrics:stop. Floating panel minimize -> metrics:stop for that collector. App shutdown -> stop sent before quit (block restart during shutdown). 200ms debounce on rapid open/close to prevent churn.
**Output:** Collector started/stopped matching visibility
**Impact scope:**
- renderer/hooks: useVisibilityLifecycle
- main/metrics: start/stop
**Acceptance criteria:**
- [ ] Given: Status panel closed
      When: Opened via Rail click
      Then: metrics:start sent, data begins flowing
      Verify: `pnpm test -- --run --grep "visibility-start"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Status panel open
      When: Hidden (close or switch to Network)
      Then: metrics:stop sent, data stops
      Verify: `pnpm test -- --run --grep "visibility-stop"`
      Verify-type: lib
      Automatable: true
- [ ] Given: App minimized
      When: Visibility API fires hidden
      Then: metrics:stop sent
      Verify: `pnpm test -- --run --grep "visibility-minimize"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Rapid panel toggle (open/close within 200ms)
      When: Debounce timer expires
      Then: Only final state sent (start or stop, not both)
      Verify: `pnpm test -- --run --grep "visibility-debounce"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- During shutdown: stop sent, subsequent start ignored (shutdown flag set)
