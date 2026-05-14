---
doc_type: spec
authority: derived
status: approved
created: 2026-05-14
spec_id: spec-2
depends_on: spec-1
---

# Spec 2: System Monitor

Status 패널의 시스템 메트릭 수집, 표시, 차트, 가시성 라이프사이클.

## Architecture Baseline

Spec 1의 아키텍처 베이스라인을 상속. 추가 모듈:

| Module | Interface | Deps |
|--------|-----------|------|
| main/metrics | MetricsService: start/stop/getData | systeminformation |
| renderer/stores | metricsSlice | zustand, preload/api |
| renderer/components | StatusPanel, TimeSeriesChart | renderer/stores |

### Data Flow

```
MetricsService (main, interval) → IPC metrics:data → metricsSlice → StatusPanel → TimeSeriesChart
```

Collection은 패널 가시성에 바인딩: `metrics:start` / `metrics:stop` IPC.

## ASR Ledger

Inherits Spec 1 ASR Ledger. Spec 2 specific entries:

| ASR | Quality Attribute | Target | Design Impact | Verification |
|-----|-------------------|--------|---------------|-------------|
| ASR-3 | Performance | monitoring-update < 100ms | Debounced metric push, Zustand selectors, requestAnimationFrame chart | `pnpm test -- --run --grep "metrics-update-latency"` |
| ASR-5 | Reliability | Zero PTY/collector leaks | MetricsService start/stop lifecycle bound to panel visibility | `pnpm test -- --run --grep "metrics-stop\|visibility-stop"` |

## Option Matrix

| Decision | Selected | Rejected | Rejection Reason |
|----------|----------|----------|-----------------|
| Metric collection | systeminformation 5 | os module + custom collectors | systeminformation provides unified API for CPU/mem/disk/process/GPU; os module lacks GPU, process details |
| Chart rendering | Canvas 2D | SVG / recharts | Canvas 2D: no DOM overhead for 60fps updates, Phosphor theme direct draw; SVG creates per-point DOM nodes |
| GPU fallback | null provider (hide section) | Error message | GPU is optional enhancement; error UX would imply broken feature |
| Collection lifecycle | Panel visibility binding (ADR-006) | Always-on | Always-on wastes CPU; visibility binding proven in BAK |

## Lifecycle And Operations

Inherits Spec 1 lifecycle. Spec 2 delta:

| Aspect | Design |
|--------|--------|
| Startup | MetricsService initialized but idle until panel visible |
| Shutdown | MetricsService.stop() called during before-quit, intervals cleared |
| Recovery | systeminformation call failure: retain last valid value, log error |
| Migration | New metric keys added to settings schema → migration fn fills defaults |

## Quality Budgets

Inherits Spec 1 budgets. Spec 2 specific:

| Quality | Budget | Risk |
|---------|--------|------|
| Performance | monitoring-update < 100ms, chart render < 16ms (60fps) | Stale data display, chart jank |
| Reliability | Zero interval leaks on panel close/app quit | Zombie intervals consuming CPU |
| Security | None declared | Risk: none (local system info only) |
| Cost | None declared | Risk: none |
| Maintainability | systeminformation API stable across v5 | API breaking change on major bump |

## Decision Log

| # | Decision | ADR | Reason |
|---|----------|-----|--------|
| 1 | systeminformation over os module | No | Library choice, swappable |
| 2 | Canvas 2D chart over SVG | No | Performance choice, reversible |
| 3 | GPU null fallback over error | No | UX choice, trivially reversible |
| 4 | Visibility lifecycle binding | ADR-006 | Cross-spec pattern, hard to reverse |

## Requirements

### R1: 시스템 메트릭 수집 서비스

**ASR:** ASR-3
**Input:** metrics:start IPC
**Behavior:**
1. systeminformation으로 CPU/memory/disk 수집
2. 설정 가능 interval (기본 1s CPU/mem, 5s disk)
3. start → interval 시작, stop → interval 정리
4. 중복 start 방지 (이미 실행 중이면 무시)
5. 수집 결과를 metrics:data IPC로 renderer에 push
**Output:** 주기적 메트릭 데이터
**Impact scope:**
- main/metrics: MetricsService
- main/ipc: metrics:start, metrics:stop, metrics:data 채널
**Acceptance criteria:**
- [ ] Given: MetricsService 정지 상태
      When: metrics:start IPC
      Then: interval 시작, 첫 데이터 100ms 이내 전달
      Verify: `pnpm test -- --run --grep "metrics-start"`
      Verify-type: lib
      Automatable: true
- [ ] Given: MetricsService 실행 중
      When: metrics:stop IPC
      Then: interval 정리, 추가 데이터 전달 없음
      Verify: `pnpm test -- --run --grep "metrics-stop"`
      Verify-type: lib
      Automatable: true
- [ ] Given: MetricsService 실행 중
      When: metrics:start 재호출
      Then: 중복 interval 없음 (기존 유지)
      Verify: `pnpm test -- --run --grep "metrics-no-duplicate"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- systeminformation 호출 실패: 마지막 유효 값 유지, 에러 로그

### R2: 프로세스 목록

**ASR:** none
**Input:** MetricsService 수집 주기
**Behavior:**
1. systeminformation.processes()로 프로세스 목록 수집
2. CPU/메모리 상위 N개 정렬 (기본 20)
3. 내부 배열 크기 제한 (bounded)
4. 수집 빈도: 기본 5s (CPU/mem보다 낮은 빈도)
**Output:** 프로세스 목록 데이터
**Impact scope:**
- main/metrics: processCollector
- renderer/components: ProcessList
**Acceptance criteria:**
- [ ] Given: MetricsService 실행 중
      When: 프로세스 수집 주기 도달
      Then: 상위 20개 프로세스 반환 (PID, name, CPU%, mem%)
      Verify: `pnpm test -- --run --grep "process-list-bounded"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 프로세스 데이터
      When: 렌더링
      Then: CPU 내림차순 정렬
      Verify: `pnpm test -- --run --grep "process-list-sort"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 프로세스 20개 미만: 있는 만큼만 표시

### R3: GPU 메트릭

**ASR:** none
**Input:** MetricsService 수집 주기
**Behavior:**
1. systeminformation.graphics()로 GPU 정보 수집
2. NVIDIA GPU 우선 (여러 GPU 시)
3. 사용률/온도/VRAM 표시
4. GPU 정보 수집 실패 시: null provider (표시 안 함, 에러 아님)
**Output:** GPU 메트릭 또는 graceful 숨김
**Impact scope:**
- main/metrics: gpuCollector
- renderer/components: GpuPanel
**Acceptance criteria:**
- [ ] Given: NVIDIA GPU 존재
      When: GPU 수집
      Then: utilization%, temperature, VRAM used/total 반환
      Verify: `pnpm test -- --run --grep "gpu-nvidia"`
      Verify-type: lib
      Automatable: true
- [ ] Given: GPU 정보 수집 불가
      When: GPU 수집 시도
      Then: null 반환, 패널에서 GPU 섹션 숨김
      Verify: `pnpm test -- --run --grep "gpu-null-fallback"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 듀얼 GPU (Intel + NVIDIA): NVIDIA 우선

### R4: CPU 패널

**ASR:** ASR-3
**Input:** metricsSlice CPU 데이터
**Behavior:**
1. CPU 사용률 % 표시
2. 코어 수, 모델명 표시
3. 60초 히스토리 차트 (TimeSeriesChart)
4. 1초 간격 데이터 포인트
**Output:** CPU 모니터링 UI
**Impact scope:**
- renderer/components: CpuPanel
**Acceptance criteria:**
- [ ] Given: CPU 데이터 수신 중
      When: 렌더링
      Then: 현재 사용률, 모델명, 코어 수, 60초 차트 표시
      Verify: `pnpm test -- --run --grep "cpu-panel-render"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 60초 이상 데이터 축적
      When: 새 데이터 도착
      Then: 오래된 데이터 드롭, 60초 윈도우 유지
      Verify: `pnpm test -- --run --grep "cpu-panel-window"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 첫 수집 전: "Collecting..." placeholder

### R5: 메모리 패널

**ASR:** ASR-3
**Input:** metricsSlice 메모리 데이터
**Behavior:**
1. 사용/전체 GB 표시
2. 사용률 % 표시
3. 60초 히스토리 차트
**Output:** 메모리 모니터링 UI
**Impact scope:**
- renderer/components: MemoryPanel
**Acceptance criteria:**
- [ ] Given: 메모리 데이터 수신 중
      When: 렌더링
      Then: used/total GB, 사용률 %, 60초 차트 표시
      Verify: `pnpm test -- --run --grep "memory-panel-render"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 메모리 > 64GB: GB 단위로 충분 (TB 불필요)

### R6: 디스크 패널

**ASR:** none
**Input:** metricsSlice 디스크 데이터
**Behavior:**
1. 드라이브별 사용/전체 GB 표시
2. 사용률 바 (색상: 90%+ 빨간)
3. 5초 간격 갱신
**Output:** 디스크 사용량 UI
**Impact scope:**
- renderer/components: DiskPanel
**Acceptance criteria:**
- [ ] Given: 디스크 데이터 수신 중
      When: 렌더링
      Then: 드라이브별 name, used, total, 사용률 바 표시
      Verify: `pnpm test -- --run --grep "disk-panel-render"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 디스크 사용률 95%
      When: 렌더링
      Then: 사용률 바 빨간색
      Verify: `pnpm test -- --run --grep "disk-panel-danger"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 네트워크 드라이브: 표시하되 별도 아이콘

### R7: 차트 컴포넌트

**ASR:** ASR-3
**Input:** 시계열 데이터 배열
**Behavior:**
1. Canvas 2D 기반 시계열 차트
2. 60초 윈도우, x축 시간, y축 0~100%
3. Phosphor 테마 컬러 (green primary)
4. requestAnimationFrame으로 갱신 (불필요 리렌더 방지)
5. 빈 데이터: 빈 차트 프레임만 표시
**Output:** 시계열 차트 렌더링
**Impact scope:**
- renderer/components: TimeSeriesChart
**Acceptance criteria:**
- [ ] Given: 60개 데이터 포인트
      When: 차트 렌더링
      Then: Canvas에 라인 차트, Phosphor green, 60초 범위
      Verify: `pnpm test -- --run --grep "chart-render"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 빈 데이터 배열
      When: 차트 렌더링
      Then: 축만 있는 빈 프레임 (크래시 없음)
      Verify: `pnpm test -- --run --grep "chart-empty"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 데이터 1개: 단일 점 표시

### R8: 가시성 라이프사이클

**ASR:** ASR-3
**Input:** 패널 열기/닫기, 윈도우 최소화/복원, 플로팅 상태 변경
**Behavior:**
1. Status 패널 보이면 → metrics:start IPC
2. Status 패널 숨기면 → metrics:stop IPC
3. 메인 윈도우 최소화 → 수집 중지
4. 플로팅 윈도우 최소화 → 해당 패널 수집 중지
5. 앱 shutdown 중 재시작 차단
**Output:** 불필요한 리소스 소비 방지
**Impact scope:**
- renderer/stores: visibilitySlice
- renderer/hooks: useVisibilityLifecycle
- main/metrics: start/stop 핸들러
**Acceptance criteria:**
- [ ] Given: Status 패널 닫힌 상태
      When: Status 열기
      Then: metrics:start 호출
      Verify: `pnpm test -- --run --grep "visibility-start-on-show"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Status 패널 열린 상태
      When: 메인 윈도우 최소화
      Then: metrics:stop 호출
      Verify: `pnpm test -- --run --grep "visibility-stop-on-minimize"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Status 플로팅 패널
      When: 플로팅 윈도우 닫기
      Then: metrics:stop 호출
      Verify: `pnpm test -- --run --grep "visibility-floating-close"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 빠른 열기/닫기 반복: 디바운스로 불필요한 start/stop 방지
