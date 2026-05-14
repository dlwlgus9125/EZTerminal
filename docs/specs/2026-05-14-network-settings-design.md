---
doc_type: spec
authority: derived
status: approved
created: 2026-05-14
spec_id: spec-3
depends_on: spec-1
---

# Spec 3: Network Monitor + Settings Extension

네트워크 트래픽 그래프, 패킷 캡처, hex dump, 연결 테이블, 모니터링 설정 항목.

## Architecture Baseline

Spec 1의 아키텍처 베이스라인을 상속. 추가 모듈:

| Module | Interface | Deps |
|--------|-----------|------|
| main/network | NetworkService: startCapture/stopCapture/getTraffic/getConnections | cap (Npcap), systeminformation |
| renderer/stores | networkSlice | zustand, preload/api |
| renderer/components | NetworkPanel, TrafficChart, PacketList, HexDump, ConnectionTable | renderer/stores |

### Data Flow

```
NetworkService (main) → IPC network:traffic / network:packets → networkSlice → NetworkPanel
cap capture (main) → ring buffer → IPC network:packets → PacketList
```

### Npcap Dependency

Npcap 미설치 시 graceful degradation: 패킷 캡처 비활성, 트래픽 그래프는 systeminformation 폴백.

## ASR Ledger

Inherits Spec 1 ASR Ledger. Spec 3 specific entries:

| ASR | Quality Attribute | Target | Design Impact | Verification |
|-----|-------------------|--------|---------------|-------------|
| ASR-3 | Performance | monitoring-update < 100ms | Debounced traffic push, Zustand selectors | `pnpm test -- --run --grep "net-update-latency"` |

## Option Matrix

| Decision | Selected | Rejected | Rejection Reason |
|----------|----------|----------|-----------------|
| Packet capture | cap 0.3 (Npcap) | raw-socket / pcap | cap: active maintenance, TypeScript types, Npcap is Windows standard |
| Npcap missing | Graceful degradation (ADR-007) | Require Npcap | Requiring Npcap blocks app startup for non-network users |
| Traffic fallback | systeminformation.networkStats() | No traffic without Npcap | Traffic graphs are useful even without packet capture |
| Hex dump format | 8 bytes/line | 16 bytes/line (Wireshark) | 8 bytes fits 300px panel width without horizontal scroll |
| Connection data | netstat-based (no Npcap) | cap-based | Connection table works independently of packet capture |

## Lifecycle And Operations

Inherits Spec 1 lifecycle. Spec 3 delta:

| Aspect | Design |
|--------|--------|
| Startup | NetworkService initialized idle; cap handle opened only on capture start |
| Shutdown | before-quit: stop capture → release cap handle → stop traffic collection |
| Recovery | cap crash: disable capture UI, traffic falls back to systeminformation |
| Migration | PacketBufferSize added to settings schema → migration fn fills default |
| Observability | Npcap detection logged at startup (present/missing/permission denied) |

## Quality Budgets

Inherits Spec 1 budgets. Spec 3 specific:

| Quality | Budget | Risk |
|---------|--------|------|
| Performance | monitoring-update < 100ms, ring buffer bounded | Memory growth from unbounded capture |
| Reliability | cap handle always released on shutdown/crash | Npcap handle leak blocks other apps |
| Security | Npcap requires admin for raw capture; document requirement | Privilege escalation UX confusion |
| Cost | Ring buffer memory: PacketBufferSize * ~200B max | None for default 1000 |
| Maintainability | cap API stable across 0.x | API may change before 1.0 |

## Decision Log

| # | Decision | ADR | Reason |
|---|----------|-----|--------|
| 1 | cap over raw-socket | No | Library choice, swappable |
| 2 | Npcap graceful degradation | ADR-007 | Native privilege dependency, two data paths |
| 3 | 8 bytes/line hex dump | No | Layout choice, trivially reversible |
| 4 | netstat for connections | No | Standard, no native dependency |
| 5 | Visibility lifecycle binding | ADR-006 | Cross-spec pattern, hard to reverse |

## Requirements

### R1: 트래픽 그래프

**ASR:** ASR-3
**Input:** networkSlice 트래픽 데이터
**Behavior:**
1. 인터페이스별 RX/TX 속도 (bytes/sec)
2. 인터페이스 셀렉터: 물리/무선/루프백/전체 그룹
3. 60초 히스토리 차트 (TimeSeriesChart 재사용)
4. 데이터 소스: Npcap 있으면 cap, 없으면 systeminformation.networkStats() 폴백
**Output:** 네트워크 트래픽 시각화
**Impact scope:**
- main/network: trafficCollector
- renderer/components: TrafficChart, InterfaceSelector
**Acceptance criteria:**
- [ ] Given: 네트워크 인터페이스 활성
      When: 트래픽 수집 중
      Then: RX/TX 속도 차트에 표시, 60초 윈도우
      Verify: `pnpm test -- --run --grep "traffic-chart-render"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 인터페이스 셀렉터
      When: 특정 인터페이스 선택
      Then: 해당 인터페이스 트래픽만 표시
      Verify: `pnpm test -- --run --grep "traffic-interface-select"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Npcap 미설치
      When: 트래픽 수집
      Then: systeminformation 폴백으로 트래픽 데이터 제공
      Verify: `pnpm test -- --run --grep "traffic-npcap-fallback"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 인터페이스 0개: "No interfaces" 메시지

### R2: 패킷 캡처

**ASR:** none
**Input:** 캡처 시작/중지 버튼
**Behavior:**
1. cap 라이브러리로 패킷 캡처 시작 (Npcap 필수)
2. ring buffer에 저장 (크기: settings PacketBufferSize, 기본 1000)
3. 캡처 중 패킷을 renderer에 push (전체 전송, bounded)
4. 방어적 IP/TCP/UDP/ICMP 파싱
5. 시작/중지 토글
**Output:** 실시간 패킷 캡처 데이터
**Impact scope:**
- main/network: PacketCaptureService
- main/ipc: network:startCapture, network:stopCapture, network:packets 채널
**Acceptance criteria:**
- [ ] Given: Npcap 설치됨
      When: 캡처 시작
      Then: 패킷 수집 시작, ring buffer에 저장
      Verify: `pnpm test -- --run --grep "capture-start"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 캡처 진행 중
      When: 캡처 중지
      Then: 캡처 정지, 기존 데이터 유지
      Verify: `pnpm test -- --run --grep "capture-stop"`
      Verify-type: lib
      Automatable: true
- [ ] Given: ring buffer 크기 1000
      When: 1500개 패킷 수신
      Then: 최신 1000개만 유지, 오래된 500개 제거
      Verify: `pnpm test -- --run --grep "capture-ring-buffer"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 손상된 패킷: 파싱 실패 시 raw bytes로 표시, 크래시 없음

### R3: Npcap 미설치 처리

**ASR:** none
**Input:** 앱 시작 시 Npcap 감지
**Behavior:**
1. Npcap 설치 여부 확인 (cap 초기화 시도)
2. 미설치: 패킷 캡처 UI 비활성 (버튼 disabled)
3. "Npcap required for packet capture" 안내 메시지 + 설치 링크
4. 트래픽 그래프는 systeminformation 폴백으로 동작
5. 연결 테이블은 독립적으로 동작 (netstat 기반)
**Output:** Npcap 없이도 앱 정상 동작
**Impact scope:**
- main/network: Npcap 감지 로직
- renderer/components: NpcapNotice
**Acceptance criteria:**
- [ ] Given: Npcap 미설치 환경
      When: Network 패널 열기
      Then: 캡처 버튼 disabled, 안내 메시지 표시, 트래픽 그래프 정상
      Verify: `pnpm test -- --run --grep "npcap-missing-graceful"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Npcap 설치 환경
      When: Network 패널 열기
      Then: 캡처 버튼 활성, 안내 메시지 없음
      Verify: `pnpm test -- --run --grep "npcap-present"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 관리자 권한 없이 Npcap 접근 실패: 캡처 비활성화 + 권한 안내

### R4: 패킷 목록

**ASR:** none
**Input:** networkSlice 패킷 데이터
**Behavior:**
1. 컬럼: timestamp, source IP, dest IP, protocol, size
2. 프로토콜 칩 필터 (TCP/UDP/ICMP/Other) — 토글 방식
3. 필터링 시 배열 교체 없이 필터링 (stable identity)
4. 패킷 클릭 시 하단에 상세 표시 (R5 hex dump)
**Output:** 패킷 목록 UI
**Impact scope:**
- renderer/components: PacketList, ProtocolChip
**Acceptance criteria:**
- [ ] Given: 캡처된 패킷 50개
      When: 패킷 목록 렌더링
      Then: 5 컬럼, 50행 표시
      Verify: `pnpm test -- --run --grep "packet-list-render"`
      Verify-type: lib
      Automatable: true
- [ ] Given: TCP 30개 + UDP 20개 패킷
      When: TCP 칩 선택
      Then: TCP 30개만 표시
      Verify: `pnpm test -- --run --grep "packet-list-filter"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 패킷 목록
      When: 패킷 행 클릭
      Then: 해당 패킷 선택, hex dump 표시
      Verify: `pnpm test -- --run --grep "packet-list-select"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 패킷 0개: "No packets captured" placeholder

### R5: Hex dump

**ASR:** none
**Input:** 선택된 패킷 raw bytes
**Behavior:**
1. 8 bytes/line 형식
2. Hex 값 + ASCII 표현 (비인쇄 문자 → '.')
3. 오프셋 표시 (00000000:)
4. 스크롤 가능
**Output:** 패킷 바이너리 시각화
**Impact scope:**
- renderer/components: HexDump
**Acceptance criteria:**
- [ ] Given: 32 byte 패킷 선택
      When: hex dump 렌더링
      Then: 4줄, 8 bytes/line, hex + ASCII
      Verify: `pnpm test -- --run --grep "hexdump-render"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 비인쇄 문자 포함 패킷
      When: hex dump 렌더링
      Then: ASCII 영역에서 '.'으로 치환
      Verify: `pnpm test -- --run --grep "hexdump-nonprintable"`
      Verify-type: pure
      Automatable: true
**Edge cases:**
- 0 byte 패킷: 빈 hex dump 표시
- 대형 패킷 (64KB+): 가상 스크롤

### R6: 연결 테이블

**ASR:** none
**Input:** Network 패널의 Connections Expander
**Behavior:**
1. 활성 네트워크 연결 목록 (PID, 프로세스명, 프로토콜, 로컬/리모트 주소, 상태)
2. Expander 펼침 시에만 수집 시작
3. Expander 접으면 수집 중지
4. netstat 기반 (Npcap 불필요)
**Output:** 네트워크 연결 테이블
**Impact scope:**
- main/network: connectionCollector
- renderer/components: ConnectionTable, Expander
**Acceptance criteria:**
- [ ] Given: Connections Expander 접힌 상태
      When: 연결 수집 여부 확인
      Then: 수집 중지 상태
      Verify: `pnpm test -- --run --grep "connection-expander-collapsed"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Connections Expander 펼침
      When: 수집 시작
      Then: 활성 연결 목록 표시 (PID, name, proto, addr, state)
      Verify: `pnpm test -- --run --grep "connection-table-render"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Connections 표시 중
      When: Expander 접기
      Then: 수집 중지
      Verify: `pnpm test -- --run --grep "connection-expander-stop"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 연결 수 1000+: 상위 200개만 표시, "showing 200/N" 안내

### R7: 모니터링 설정 항목

**ASR:** none
**Input:** Settings 패널 (Spec 1 R17 확장)
**Behavior:**
1. Settings 패널에 모니터링 섹션 추가:
   - 수집 간격 (초): CPU/mem, disk, process 개별
   - 패킷 버퍼 크기 (PacketBufferSize)
2. 변경 시 실행 중인 collector에 즉시 반영
3. 원자적 저장 (Spec 1 R17과 동일 메커니즘)
**Output:** 모니터링 설정 변경 UI
**Impact scope:**
- renderer/components: SettingsPanel (확장)
- renderer/stores: settingsSlice (확장)
- main/settings: 설정 스키마 확장
- main/metrics: interval 동적 변경
**Acceptance criteria:**
- [ ] Given: Settings 패널
      When: CPU 수집 간격을 2초로 변경
      Then: MetricsService가 2초 간격으로 전환
      Verify: `pnpm test -- --run --grep "settings-metric-interval"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Settings 패널
      When: PacketBufferSize를 500으로 변경
      Then: ring buffer 크기 500으로 조정
      Verify: `pnpm test -- --run --grep "settings-packet-buffer"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 간격 0 또는 음수: 최소 1초 강제

### R8: 네트워크 가시성 라이프사이클

**ASR:** ASR-3
**Input:** 패널/윈도우 가시성 변경
**Behavior:**
1. Network 패널 보이면 → 트래픽 수집 시작
2. Network 패널 숨기면 → 트래픽 수집 + 캡처 중지
3. 메인 윈도우 최소화 → 수집 중지
4. 플로팅 Network 패널 최소화 → 수집 중지
5. 앱 shutdown 시: 캡처 정리, cap 핸들 해제
**Output:** 불필요한 네트워크 리소스 소비 방지
**Impact scope:**
- renderer/hooks: useVisibilityLifecycle (Spec 2 R8 재사용)
- main/network: start/stop 핸들러
**Acceptance criteria:**
- [ ] Given: Network 패널 닫힌 상태
      When: Network 열기
      Then: traffic 수집 시작
      Verify: `pnpm test -- --run --grep "net-visibility-start"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Network 패널 열린 상태 + 캡처 진행 중
      When: 패널 숨기기
      Then: traffic 수집 + 캡처 모두 중지
      Verify: `pnpm test -- --run --grep "net-visibility-stop-all"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 앱 shutdown
      When: before-quit
      Then: cap 핸들 해제, 캡처 중지
      Verify: `pnpm test -- --run --grep "net-shutdown-cleanup"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 캡처 없이 패널만 닫기: 트래픽 수집만 중지, 캡처 stop 불필요
