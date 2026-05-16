---
doc_type: spec
authority: canonical
status: approved
created: 2026-05-16
layer_structure: L1-L4
total_requirements: 28
total_positive_acs: 80
total_negative_acs: 28
---

# EZTerminal Integrated Design Spec

> 전체 범위 통합 설계. 이전 4개 개별 spec을 폐기하고, Layer 순서로
> wiring 가능한 단일 설계 문서로 재구성.

## Architecture Baseline

### 결정 요약

| 결정 | 선택 | 근거 |
|------|------|------|
| 구현 순서 | L1→L2→L3→L4 | Terminal 코어 먼저, 나머지는 의존 |
| State 관리 | Zustand 4-slice (terminal/layout/panel/settings) | cross-slice: action 내 get() 직접 조율 |
| IPC 타입 | src/shared/ 공유 타입 | unknown → 구체 타입, 컴파일 타임 보장 |
| 에러 처리 | IpcResult\<T\> 패턴 | 명시적 ok/error 구조 |
| PTY 수명주기 | Pane 1:1 결합 | Map 추적, before-quit guard, 30s orphan |
| WebGL 전략 | 활성 탭만 WebGL, hidden 시 dispose+재생성 | context 수 = 활성 pane 수 (max 4) |
| Files 패널 | 읽기 전용 | CWD scope + extension whitelist + traversal 차단 |
| Npcap UX | 부분 기능 표시 | traffic/connection 항상, capture/hexdump Npcap 필요 |
| Scrollback | 20K 유지 | 극단적 40 pane도 ~160MB 허용 |
| 16ms budget | Coalescing window만 | 전체 key-to-screen ~32-50ms |
| Settings 동시성 | Main 단일 소유자 | 모든 renderer IPC 경유 |
| File protocol 보안 | CWD scope + whitelist + 10MB | path traversal 차단 |

### Module Boundaries

```
src/
  shared/             ← IPC types, settings, metrics, network, terminal types
  main/
    index.ts          ← App entry + IPC handler registration
    pty-manager.ts    ← PTY session lifecycle (Map<id, IPty>)
    frame-buffer.ts   ← 16ms coalescing buffer
    settings.ts       ← File-based settings persistence (atomic write)
    metrics.ts        ← systeminformation collector
    network.ts        ← cap/Npcap + networkStats fallback
    filesystem.ts     ← chokidar watcher + directory read
    file-protocol.ts  ← ezterm-file:// protocol handler (ADR-009)
    logger.ts         ← electron-log setup
  preload/
    index.ts          ← Typed contextBridge (ElectronAPI)
  renderer/
    main.tsx          ← React root
    App.tsx           ← Root layout
    store/            ← 4 slices (terminal, layout, panel, settings)
    components/       ← TitleBar, TabBar, StatusBar, Terminal, SplitContainer,
                        Rail, panels/*, FloatingPanel, CommandPalette,
                        ContextMenu, FindBar
    hooks/            ← useVisibilityLifecycle, usePty
    styles/           ← theme.css, global.css
```

### Wiring Map

#### Entry Points (WM-EP)

| ID | Entry Point | Layer |
|----|-------------|-------|
| WM-EP-1 | main/index.ts → app.whenReady | Main |
| WM-EP-2 | renderer/main.tsx → ReactDOM.createRoot | Renderer |
| WM-EP-3 | preload/index.ts → contextBridge.exposeInMainWorld | Preload |

#### Component Registration (WM-REG)

| ID | Component | Where | Probe |
|----|-----------|-------|-------|
| WM-REG-1 | IPC handler 등록 | main/index.ts | runtime-load |
| WM-REG-2 | PTY session 등록 | main/pty-manager.ts | runtime-load |
| WM-REG-3 | React component tree | App.tsx → Layout | import-chain |
| WM-REG-4 | Zustand store slices | store/index.ts | import-chain |
| WM-REG-5 | xterm.js addon 로딩 | Terminal/TerminalView | runtime-load |
| WM-REG-6 | Visibility lifecycle | panels/* mount | e2e-touch |
| WM-REG-7 | ezterm-file:// protocol | main/file-protocol.ts | runtime-load |
| WM-REG-8 | chokidar watcher | main/filesystem.ts | runtime-load |
| WM-REG-9 | Frame coalescing buffer | main/frame-buffer.ts | runtime-load |

#### Data Flow (WM-DF)

| ID | Flow | Path |
|----|------|------|
| WM-DF-1 | Terminal I/O | keypress → pty:write → stdin → stdout → frame-buffer → pty:data:{id} → xterm.write |
| WM-DF-2 | Terminal resize | addon-fit → pty:resize → PTY.resize(cols,rows) |
| WM-DF-3 | Settings persist | settings:load → file read → renderer; save → atomic write |
| WM-DF-4 | System metrics | metrics:start → SI poll → metrics:update → StatusPanel |
| WM-DF-5 | Network traffic | network:start → cap/SI → network:traffic → NetworkPanel |
| WM-DF-6 | File explorer | OSC 7 CWD → chokidar → IPC → file tree → virtual scroll |
| WM-DF-7 | Layout state | action → layoutSlice → LayoutNode → CSS Grid |
| WM-DF-8 | File preview | click → ezterm-file:// → preview component |
| WM-DF-9 | Settings broadcast | save → main write → broadcast all renderers |

#### Cross-cutting (WM-C)

| ID | Concern | Strategy |
|----|---------|----------|
| WM-C-1 | IPC error propagation | IpcResult\<T\> on all invoke channels |
| WM-C-2 | PTY cleanup | before-quit + exit guard + 30s orphan |
| WM-C-3 | Collector lifecycle | useVisibilityLifecycle (ADR-006) |
| WM-C-4 | Logging | electron-log, main only, 6 tags |
| WM-C-5 | WebGL context | active-only + dispose/recreate |
| WM-C-6 | Cross-slice coordination | action 내 get() 직접 조율 |

---

## ASR Ledger

| ID | Quality | Target | Design Impact | Verify |
|----|---------|--------|---------------|--------|
| ASR-01 | Performance | App start → shell prompt < 3s | Eager PTY create at window ready, defer panel init | `pnpm test:e2e -- --grep "Terminal startup"` |
| ASR-02 | Performance | Key-to-PTY < 16ms (coalescing window) | 16ms frame buffer in main, fire-and-forget pty:write | `pnpm test -- --grep "FrameBuffer"` |
| ASR-03 | Performance | Monitoring update < 100ms | systeminformation poll → IPC push, no transform in renderer hot path | `pnpm test -- --grep "Metrics"` |
| ASR-04 | Performance | Bundle < 15MB | Tree-shake, dynamic import for cap/systeminformation | `du -sh out/ \| awk '{print $1}'` |
| ASR-05 | Reliability | PTY 프로세스 누수 0건 | Pane 1:1, Map 추적, before-quit guard, 30s orphan | `pnpm test -- --grep "PtyManager"` |
| ASR-06 | Reliability | Npcap 미설치 시 정상 동작 | cap optional import, networkStats fallback (ADR-007) | `pnpm test -- --grep "Network npcap"` |
| ASR-07 | Reliability | Settings 파일 손상 복구 | Atomic .tmp→rename, corrupt 감지 시 기본값 복구 | `pnpm test -- --grep "Settings corrupt"` |
| ASR-08 | Security | CWD scope + whitelist + traversal 차단 | ezterm-file:// protocol validator (ADR-009) | `pnpm test -- --grep "Protocol"` |
| ASR-09 | Security | Renderer에서 Node API 직접 접근 불가 | contextIsolation: true, nodeIntegration: false (ADR-001) | `pnpm typecheck` |
| ASR-10 | Maintainability | 3-layer 경계 위반 0건 | TypeScript strict, preload-only IPC bridge | `pnpm typecheck && pnpm lint` |

## Option Matrix

| Concern | Option A (Selected) | Option B (Rejected) | Tradeoff |
|---------|---------------------|---------------------|----------|
| State 관리 | Zustand 4-slice | Redux Toolkit | Zustand: 최소 보일러플레이트, slice 자동 조합. Redux: 미들웨어 에코시스템이지만 Electron 데스크톱에 과도 |
| IPC 에러 | IpcResult\<T\> 패턴 | Electron throw 전파 | Result: 명시적, renderer에서 분기 용이. Throw: 암묵적, 에러 타입 보장 없음 |
| PTY buffering | 16ms coalescing (ADR-003) | 즉시 전송 (no buffer) | Coalescing: IPC 호출 수 60fps 제한. 즉시: 대량 출력 시 IPC 폭주 |
| Split container | Custom CSS Grid (ADR-004) | allotment library | Custom: 비대칭 레이아웃 완전 제어, 번들 절약. Allotment: 검증된 라이브러리지만 커스터마이징 제한 |
| WebGL 전략 | Active-only + dispose/recreate | 전체 유지 + context pool | Active-only: context 수 = max 4, 재생성 비용 ~10ms. 전체 유지: context 누적, GPU 메모리 부담 |
| CWD detection | OSC 7 + Win32 fallback (ADR-008) | Shell profile injection only | OSC 7: 표준, shell-agnostic. Shell profile: PowerShell/bash 각각 설정 필요 |
| File protocol | ezterm-file:// custom (ADR-009) | file:// protocol | Custom: CWD scope 강제 가능. file://: CSP 제한, 전체 파일시스템 접근 |
| Network fallback | 부분 기능 표시 (ADR-007) | 전체 패널 비활성화 | 부분: traffic/connection은 항상 유용. 전체 비활성: Npcap 없으면 Network 탭 무용 |
| Settings persistence | Atomic .tmp→rename | SQLite / electron-store | Atomic: 의존성 0, 단순. SQLite: 쿼리 기능이지만 설정 규모에 과도 |

## Lifecycle & Operations

### Startup Sequence

```
1. app.whenReady()
2. registerFileProtocol("ezterm-file")     ← WM-REG-7
3. registerIpcHandlers()                    ← WM-REG-1
4. PtyManager.init() (orphan scan timer)   ← WM-REG-2
5. SettingsManager.init() (load/create)
6. Logger.init() (electron-log tags)
7. createWindow() → BrowserWindow
8. preload: contextBridge.exposeInMainWorld ← WM-EP-3
9. renderer: ReactDOM.createRoot()          ← WM-EP-2
10. App mount → initial Tab/Pane → pty:create
11. Shell prompt visible (< 3s target)      ← ASR-01
```

### Shutdown Sequence

```
1. app.on('before-quit')
2. PtyManager.killAll() → Map.forEach(kill) + clear  ← WM-C-2
3. MetricsCollector.stop() + NetworkCollector.stop()   ← WM-C-3
4. chokidar watcher.close()
5. SettingsManager.flush() (pending writes)
6. BrowserWindow.close() (main + floating)
7. process.exit
```

### Recovery

| Scenario | Recovery |
|----------|----------|
| PTY crash mid-session | pty:exit event → Pane에 "Shell exited" 표시, 재시작 버튼 |
| Settings corruption | 감지 시 기본값 복구, SETTINGS_CORRUPT 코드 반환 |
| WebGL context lost | Canvas fallback (ADR-005) |
| Npcap 런타임 실패 | networkStats fallback (ADR-007) |
| chokidar watcher 에러 | 파일 트리 정지, "새로고침" 버튼 |

### Deployment

- Platform: Windows 10/11 x64
- Installer: Electron Forge Squirrel.Windows
- Runtime deps: Npcap (optional, user-installed)
- Node: 20+ (Electron 36 내장)
- Build: `pnpm build` → `.exe` installer

### Compatibility

- semver after v1.0 (config.json policy)
- Settings migration: version 필드 추가, 마이그레이션 함수 체인
- IPC 계약 변경 시 major version bump

### Observability

- electron-log: main process only
- Tags: app, pty, metrics, network, filesystem, settings
- Log level: info (production), debug (development)
- Log location: `%APPDATA%/EZTerminal/logs/`
- Diagnostic: DevTools (Ctrl+Shift+I in dev mode)

### Ownership

- Owner: EZTerminal core team (single developer project)
- Escalation: GitHub Issues (https://github.com/EZTerminal/issues)
- On-call: N/A (local desktop application, no server infrastructure)

## Quality Budgets

| Category | Budget | Metric | Risk if exceeded |
|----------|--------|--------|------------------|
| Startup | < 3s | App launch → shell prompt | 사용자 이탈, PRD 실패 |
| Key-to-PTY | < 16ms | Keystroke → pty:write send | 체감 입력 지연 |
| Key-to-screen | ~32-50ms | Keystroke → xterm render | 16ms coalescing + IPC + render. PRD budget(16ms)은 coalescing만 해당. 전체 latency는 50ms 이내 목표 |
| Monitoring update | < 100ms | SI poll → panel render | 차트 갱신 지연 |
| Bundle size | < 15MB | Packaged app total | 다운로드/설치 시간 증가 |
| Reliability | PTY 누수 0건 | orphan scan count | 좀비 프로세스 축적 |
| Security | traversal/injection 0건 | protocol validator test | 파일시스템 접근 위반 |
| Maintainability | strict TS + biome 0 warnings | `pnpm typecheck && pnpm lint` | 타입 안전성 저하 |
| Cost | none declared | N/A | 로컬 데스크톱 앱, 클라우드 비용 없음. Electron/node-pty/systeminformation 의존성 비용은 bundle < 15MB budget으로 모니터링 |

> **Note**: key-to-pty 16ms는 config.json의 `performance_budgets`에서 coalescing window를 의미.
> 전체 key-to-screen latency는 IPC serialization + xterm render 포함 ~32-50ms.
> 이 차이는 의도적이며 ADR-003의 coalescing 결정에 의한 것.

## Decision Log

| Decision | ADR | Status | Rationale |
|----------|-----|--------|-----------|
| Electron 3-layer + typed IPC | ADR-001 | Accepted | contextIsolation 보안 + 타입 안전 |
| xterm.js full delegation | ADR-002 | Accepted | 커스텀 VT 파서 비용 대비 이점 없음 |
| 16ms PTY frame coalescing | ADR-003 | Accepted | IPC 폭주 방지, 60fps 렌더링 |
| Custom SplitContainer | ADR-004 | Accepted | 비대칭 레이아웃 + 번들 절약 |
| Persist xterm via display:none | ADR-005 | Accepted | 탭 전환 시 버퍼 보존 |
| Visibility lifecycle for collectors | ADR-006 | Accepted | 리소스 절약, 불필요한 폴링 방지 |
| Npcap graceful degradation | ADR-007 | Accepted | 선택적 의존성, 핵심 기능 보호 |
| OSC 7 CWD + Win32 fallback | ADR-008 | Accepted | Shell-agnostic CWD 감지 |
| Custom file protocol | ADR-009 | Accepted | CWD scope 보안 강제 |
| Active-only WebGL + dispose/recreate | ADR-005 (amended) | Accepted | ADR-005 amendment: display:none 유지하되 WebGL context는 hidden 시 dispose, 활성화 시 재생성. context 수 = max 4 |
| Scrollback 20K 고정 | — | Decided (spec) | 동적 조절 복잡도 대비 ~160MB 극단 케이스 허용 |
| Main-only settings ownership | — | Decided (spec) | Floating window 동시 접근 문제 방지 |

> ADR required: yes (config.json `adr_required: true`). 기존 9개 ADR 완료.
> Spec 내 신규 결정 3건은 ADR 불필요 판단 — 기존 ADR의 세부 적용 사항이며 역전 비용 낮음.

---

## Layer 1 — Terminal Core

### R-L1-01: Shared IPC Type Definitions

ASR: ASR-09, ASR-10

src/shared/에 모든 IPC 메시지의 TypeScript 타입 정의.
main, preload, renderer 3개 레이어가 동일한 타입을 import.

**AC-01-1**: IpcResult 타입 정의
- Given: src/shared/ipc-types.ts 존재
- When: IpcResult\<T\> 타입 정의
- Then: `{ ok: true; data: T } | { ok: false; code: string; message: string }` union
- Verify: `pnpm typecheck`
- Verify-type: typecheck

**AC-01-2**: PTY 채널 타입
- Given: src/shared/terminal-types.ts 존재
- When: PtyCreateOptions, PtySession 정의
- Then: cols/rows number, shell optional string, session ID string
- Verify: `pnpm typecheck`
- Verify-type: typecheck

**AC-01-3**: Metrics 타입
- Given: src/shared/metrics-types.ts 존재
- When: MetricsData 정의
- Then: cpu(usage, cores), memory(total, used, available), disk(name, size, used), gpu(optional)
- Verify: `pnpm typecheck`
- Verify-type: typecheck

**AC-01-4**: Network 타입
- Given: src/shared/network-types.ts 존재
- When: TrafficData, ConnectionInfo, PacketData 정의
- Then: traffic(rx/tx bytes/sec), connection(proto, local, remote, state), packet(timestamp, src, dst, protocol, data)
- Verify: `pnpm typecheck`
- Verify-type: typecheck

**AC-01-5**: Settings 타입
- Given: src/shared/settings-types.ts 존재
- When: UserSettings 정의
- Then: shell(path, args), font(family, size), terminal(scrollback, cursorStyle), monitoring(interval), theme
- Verify: `pnpm typecheck`
- Verify-type: typecheck

**AC-01-N1** (Negative): preload unknown 타입 금지
- Given: preload/index.ts가 shared 타입 import
- When: ElectronAPI 인터페이스 검사
- Then: unknown 타입 0개
- Verify: `grep -c "unknown" src/preload/index.ts | test $(cat) -eq 0`
- Verify-type: script

---

### R-L1-02: PTY Session Manager

ASR: ASR-05

main process에서 node-pty 세션 생성, 추적, 정리.
Pane 1:1 결합, 누수 방지 핵심.

**AC-02-1**: PTY 세션 생성
- Given: PtyManager 초기화
- When: create(opts: PtyCreateOptions) 호출
- Then: UUID session ID 반환, Map 등록
- Verify: `pnpm test -- --grep "PtyManager create"`
- Verify-type: unit

**AC-02-2**: PTY 세션 종료
- Given: 활성 PTY 세션 존재
- When: kill(sessionId) 호출
- Then: PTY 프로세스 종료, Map 제거
- Verify: `pnpm test -- --grep "PtyManager kill"`
- Verify-type: unit

**AC-02-3**: App 종료 시 전체 정리
- Given: 복수 PTY 활성
- When: app.on('before-quit') 발생
- Then: Map 전체 kill + clear
- Verify: `pnpm test -- --grep "PtyManager cleanup"`
- Verify-type: unit

**AC-02-4**: Orphan 검사
- Given: 30초 간격 orphan scan
- When: Map에 등록되었지만 프로세스 종료된 PTY 존재
- Then: Map에서 제거 + 로그
- Verify: `pnpm test -- --grep "PtyManager orphan"`
- Verify-type: unit

**AC-02-N1** (Negative): 잘못된 shell 경로
- Given: PtyManager 초기화
- When: create({ cols: 80, rows: 24, shell: "/nonexistent/shell" })
- Then: IpcResult { ok: false, code: "PTY_CREATE_FAILED" }
- Verify: `pnpm test -- --grep "PtyManager invalid shell"`
- Verify-type: unit

**AC-02-N2** (Negative): 존재하지 않는 세션 kill
- Given: Map에 해당 ID 없음
- When: kill("nonexistent-id")
- Then: IpcResult { ok: false, code: "SESSION_NOT_FOUND" }
- Verify: `pnpm test -- --grep "PtyManager kill nonexistent"`
- Verify-type: unit

---

### R-L1-03: 16ms Frame Coalescing

ASR: ASR-02

PTY stdout 16ms 윈도우 버퍼링, 배치 IPC 전송 (ADR-003).

**AC-03-1**: 버퍼링 윈도우
- Given: PTY 빠른 stdout 출력
- When: 16ms 이내 여러 청크 도착
- Then: 하나의 IPC 메시지로 합쳐 전송
- Verify: `pnpm test -- --grep "FrameBuffer coalesce"`
- Verify-type: unit

**AC-03-2**: 타이머 시작
- Given: 16ms 윈도우 미시작
- When: 첫 stdout 청크 도착
- Then: 16ms 타이머 시작, 만료 시 플러시
- Verify: `pnpm test -- --grep "FrameBuffer flush"`
- Verify-type: unit

**AC-03-3**: 세션별 독립 버퍼
- Given: 복수 PTY 활성
- When: 각 세션 독립 stdout
- Then: 세션별 독립 coalescing
- Verify: `pnpm test -- --grep "FrameBuffer per-session"`
- Verify-type: unit

**AC-03-N1** (Negative): 세션 종료 후 잔여 버퍼
- Given: PTY 세션 종료
- When: coalescing 타이머 활성
- Then: 타이머 취소, 잔여 버퍼 폐기
- Verify: `pnpm test -- --grep "FrameBuffer cleanup"`
- Verify-type: unit

---

### R-L1-04: PTY IPC Handlers

ASR: ASR-02, ASR-09

main process PTY IPC 채널 핸들러 등록.
pty:create(invoke), pty:write(send), pty:resize(send),
pty:kill(invoke), pty:data/exit(push).

**AC-04-1**: pty:create 핸들러
- Given: IPC 핸들러 등록
- When: renderer에서 pty:create invoke
- Then: PtyManager.create() + IpcResult\<string\> 반환
- Verify: `pnpm test -- --grep "IPC pty:create"`
- Verify-type: unit

**AC-04-2**: pty:write 핸들러
- Given: 활성 PTY 세션
- When: pty:write(id, data) send
- Then: PTY stdin에 data 기록
- Verify: `pnpm test -- --grep "IPC pty:write"`
- Verify-type: unit

**AC-04-3**: pty:resize 핸들러
- Given: 활성 PTY 세션
- When: pty:resize(id, cols, rows) send
- Then: PTY resize(cols, rows)
- Verify: `pnpm test -- --grep "IPC pty:resize"`
- Verify-type: unit

**AC-04-4**: pty:data push
- Given: PTY stdout 출력
- When: frame-buffer 16ms 만료
- Then: pty:data:{id} 채널로 배치 push
- Verify: `pnpm test -- --grep "IPC pty:data push"`
- Verify-type: unit

**AC-04-N1** (Negative): 존재하지 않는 세션 write
- Given: Map에 session ID 없음
- When: pty:write("nonexistent", "data") send
- Then: 에러 없이 무시 (fire-and-forget)
- Verify: `pnpm test -- --grep "IPC pty:write nonexistent"`
- Verify-type: unit

---

### R-L1-05: Preload Typed Bridge

ASR: ASR-09, ASR-10

preload ElectronAPI를 shared 타입으로 교체. 모든 채널 구체 타입.

**AC-05-1**: PTY 채널 타입
- Given: preload가 shared 타입 import
- When: pty.create 반환 타입 검사
- Then: Promise\<IpcResult\<string\>\>
- Verify: `pnpm typecheck`
- Verify-type: typecheck

**AC-05-2**: Metrics 채널 타입
- Given: MetricsData import
- When: metrics.onUpdate 콜백 타입 검사
- Then: (data: MetricsData) => void
- Verify: `pnpm typecheck`
- Verify-type: typecheck

**AC-05-3**: Settings 채널 타입
- Given: UserSettings import
- When: settings.load 반환 타입 검사
- Then: Promise\<IpcResult\<UserSettings\>\>
- Verify: `pnpm typecheck`
- Verify-type: typecheck

**AC-05-N1** (Negative): 잘못된 타입 사용 시 컴파일 에러
- Given: preload에서 ElectronAPI 채널의 타입이 shared와 불일치한다
- When: pnpm typecheck을 실행한다
- Then: 타입 에러가 발생한다 (컴파일 타임 보장)
- Verify: `pnpm typecheck`
- Verify-type: typecheck

---

### R-L1-06: TerminalView Component

ASR: ASR-02

xterm.js Terminal React wrapper. WebGL, addon, Phosphor theme.

**AC-06-1**: xterm.js 마운트
- Given: TerminalView 렌더링
- When: DOM 마운트
- Then: Terminal 인스턴스 생성 + container div open()
- Verify: `pnpm test -- --grep "TerminalView mount"`
- Verify-type: component

**AC-06-2**: WebGL addon 로딩
- Given: 활성 탭
- When: 마운트 후 addon 로딩
- Then: WebglAddon loadAddon(), 실패 시 Canvas fallback
- Verify: `pnpm test -- --grep "TerminalView webgl"`
- Verify-type: component

**AC-06-3**: addon-fit
- Given: TerminalView 마운트
- When: 컨테이너 크기 변경
- Then: FitAddon.fit() + cols/rows 재계산
- Verify: `pnpm test -- --grep "TerminalView fit"`
- Verify-type: component

**AC-06-4**: Phosphor 테마
- Given: [data-theme='dark'] 설정
- When: 테마 적용
- Then: xterm theme = Phosphor CSS custom property 값
- Verify: `pnpm test -- --grep "TerminalView theme"`
- Verify-type: component

**AC-06-5**: 언마운트 정리
- Given: TerminalView 마운트 상태
- When: 언마운트
- Then: WebGL dispose, xterm instance 유지 (ADR-005)
- Verify: `pnpm test -- --grep "TerminalView unmount"`
- Verify-type: component

**AC-06-N1** (Negative): WebGL 실패 Canvas fallback
- Given: WebGL addon 로딩 실패
- When: loadAddon 에러
- Then: Canvas 렌더러로 정상 동작
- Verify: `pnpm test -- --grep "TerminalView canvas fallback"`
- Verify-type: component

**AC-06-N2** (Negative): 0 크기 컨테이너
- Given: width/height 0
- When: FitAddon.fit() 호출
- Then: resize 스킵, 에러 없음
- Verify: `pnpm test -- --grep "TerminalView zero size"`
- Verify-type: component

---

### R-L1-07: Terminal I/O Wiring (E2E)

ASR: ASR-01, ASR-02

키 입력 → xterm 화면까지 전체 경로. L1 최종 wiring 검증.

**AC-07-1**: 키 입력 echo
- Given: TerminalView + PTY 연결
- When: "hello" 입력
- Then: xterm에 "hello" 표시
- Verify: `pnpm test:e2e -- --grep "Terminal echo"`
- Verify-type: e2e

**AC-07-2**: 커맨드 실행
- Given: PowerShell PTY
- When: "echo test\n" 입력
- Then: "test" 출력 표시
- Verify: `pnpm test:e2e -- --grep "Terminal command"`
- Verify-type: e2e

**AC-07-3**: 시작 성능
- Given: 앱 실행
- When: 완전 로드
- Then: 3초 이내 셸 프롬프트 (PRD)
- Verify: `pnpm test:e2e -- --grep "Terminal startup"`
- Verify-type: e2e

**AC-07-N1** (Negative): PTY 생성 실패 UI
- Given: PTY 생성 실패
- When: IpcResult { ok: false }
- Then: 에러 메시지 표시
- Verify: `pnpm test -- --grep "Terminal pty error"`
- Verify-type: component

---

## Layer 2 — Shell & Layout

### R-L2-01: Zustand Store Architecture

ASR: ASR-10

4-slice Zustand store. terminal, layout, panel, settings.

**AC-01-1**: Store 생성
- Given: store/index.ts create()
- When: 4 slice 조합
- Then: 단일 useStore hook 접근
- Verify: `pnpm test -- --grep "Store creation"`
- Verify-type: unit

**AC-01-2**: terminalSlice
- Given: terminalSlice 정의
- When: state 검사
- Then: sessions(Map), activeSessionId
- Verify: `pnpm test -- --grep "terminalSlice"`
- Verify-type: unit

**AC-01-3**: layoutSlice
- Given: layoutSlice 정의
- When: state 검사
- Then: tabs, activeTabId, LayoutNode tree
- Verify: `pnpm test -- --grep "layoutSlice"`
- Verify-type: unit

**AC-01-4**: Cross-slice 조율
- Given: closeTab action
- When: closeTab(tabId)
- Then: PTY kill + 탭 제거 순서 수행
- Verify: `pnpm test -- --grep "cross-slice closeTab"`
- Verify-type: unit

**AC-01-N1** (Negative): 마지막 탭 닫기 차단
- Given: 탭 1개
- When: closeTab()
- Then: 거부, 탭 유지
- Verify: `pnpm test -- --grep "closeTab last tab"`
- Verify-type: unit

---

### R-L2-02: Tab Management

ASR: ASR-05

탭 생성/닫기/전환. 마지막 탭 차단.

**AC-02-1**: 새 탭 생성
- Given: 탭 바 표시
- When: Ctrl+T
- Then: 새 탭 + PTY 세션 생성
- Verify: `pnpm test:e2e -- --grep "Tab create"`
- Verify-type: e2e

**AC-02-2**: 탭 닫기
- Given: 탭 2개+
- When: Ctrl+W
- Then: 현재 탭 닫기 + PTY 종료
- Verify: `pnpm test:e2e -- --grep "Tab close"`
- Verify-type: e2e

**AC-02-3**: 탭 전환
- Given: 탭 2개+
- When: Ctrl+Tab
- Then: 다음 탭, WebGL 재생성
- Verify: `pnpm test:e2e -- --grep "Tab switch"`
- Verify-type: e2e

**AC-02-N1** (Negative): 마지막 탭 Ctrl+W
- Given: 탭 1개
- When: Ctrl+W
- Then: 닫히지 않음
- Verify: `pnpm test:e2e -- --grep "Tab close last blocked"`
- Verify-type: e2e

---

### R-L2-03: Pane Splitting

ASR: ASR-05

탭 내 최대 4 pane. LayoutNode binary tree.

**AC-03-1**: 우측 분할
- Given: 단일 pane 탭
- When: Ctrl+Shift+D
- Then: 좌/우 분할, 우측 새 PTY
- Verify: `pnpm test:e2e -- --grep "Pane split right"`
- Verify-type: e2e

**AC-03-2**: 하단 분할
- Given: 단일 pane 탭
- When: Ctrl+Shift+E
- Then: 상/하 분할
- Verify: `pnpm test:e2e -- --grep "Pane split down"`
- Verify-type: e2e

**AC-03-3**: Pane 닫기
- Given: 2+ pane
- When: Ctrl+Shift+W
- Then: pane 닫기 + PTY 종료 + 남은 pane 확장
- Verify: `pnpm test:e2e -- --grep "Pane close"`
- Verify-type: e2e

**AC-03-4**: Pane 포커스 이동
- Given: 2+ pane
- When: Ctrl+Alt+Arrow
- Then: 인접 pane 포커스
- Verify: `pnpm test:e2e -- --grep "Pane focus"`
- Verify-type: e2e

**AC-03-N1** (Negative): 4 pane 초과
- Given: 4 pane
- When: Ctrl+Shift+D
- Then: 분할 안 됨
- Verify: `pnpm test:e2e -- --grep "Pane split max"`
- Verify-type: e2e

**AC-03-N2** (Negative): 마지막 pane 닫기
- Given: 1 탭, 1 pane
- When: Ctrl+Shift+W
- Then: 닫히지 않음
- Verify: `pnpm test:e2e -- --grep "Pane close last blocked"`
- Verify-type: e2e

---

### R-L2-04: SplitContainer Component

ASR: none

CSS Grid 재귀 분할. LayoutNode tree 렌더링.

**AC-04-1**: LayoutNode 렌더링
- Given: horizontal split tree
- When: SplitContainer 렌더링
- Then: CSS Grid 수평 2 pane
- Verify: `pnpm test -- --grep "SplitContainer render"`
- Verify-type: component

**AC-04-2**: 6px 거터 드래그
- Given: 2 pane + 6px 거터
- When: 거터 드래그
- Then: pane 비율 조정
- Verify: `pnpm test -- --grep "SplitContainer gutter drag"`
- Verify-type: component

**AC-04-3**: 더블클릭 리셋
- Given: 30:70 비율
- When: 거터 더블클릭
- Then: 50:50 리셋
- Verify: `pnpm test -- --grep "SplitContainer reset"`
- Verify-type: component

**AC-04-N1** (Negative): 잘못된 LayoutNode
- Given: LayoutNode type이 'split'이지만 children이 비어있다
- When: SplitContainer가 렌더링을 시도한다
- Then: 빈 fallback UI가 표시되고 에러가 발생하지 않는다
- Verify: `pnpm test -- --grep "SplitContainer invalid node"`
- Verify-type: component

---

### R-L2-05: TitleBar Component

ASR: none

Frameless 커스텀 타이틀바. 드래그 + min/max/close.

**AC-05-1**: 윈도우 드래그
- Given: TitleBar 렌더링
- When: 드래그
- Then: 윈도우 이동 (-webkit-app-region: drag)
- Verify: `pnpm test -- --grep "TitleBar drag"`
- Verify-type: component

**AC-05-2**: 윈도우 컨트롤
- Given: 3 버튼
- When: 클릭
- Then: minimize/maximize/close IPC
- Verify: `pnpm test -- --grep "TitleBar controls"`
- Verify-type: component

---

### R-L2-06: TabBar Component

ASR: none

탭 목록 + 새 탭 버튼 + 전환.

**AC-06-1**: 탭 목록 렌더링
- Given: 3 탭
- When: TabBar 렌더링
- Then: 3 탭 + 활성 표시
- Verify: `pnpm test -- --grep "TabBar render"`
- Verify-type: component

**AC-06-2**: 새 탭 버튼
- Given: + 버튼
- When: 클릭
- Then: layoutSlice.addTab()
- Verify: `pnpm test -- --grep "TabBar add"`
- Verify-type: component

---

### R-L2-07: StatusBar Component

ASR: none

셸 이름, 터미널 크기, 인코딩.

**AC-07-1**: 상태 표시
- Given: PowerShell 80x24
- When: StatusBar 렌더링
- Then: "PowerShell" | "80x24" | "UTF-8"
- Verify: `pnpm test -- --grep "StatusBar display"`
- Verify-type: component

---

### R-L2-08: Keyboard Shortcuts

ASR: none

UX Spec 전체 단축키 바인딩.

**AC-08-1**: 글로벌 단축키
- Given: 앱 포커스
- When: Ctrl+T/W/Tab
- Then: 해당 액션 실행
- Verify: `pnpm test:e2e -- --grep "Keyboard global"`
- Verify-type: e2e

**AC-08-2**: 터미널 단축키
- Given: 터미널 포커스
- When: Ctrl+Shift+D
- Then: 액션 실행, PTY 미전달
- Verify: `pnpm test:e2e -- --grep "Keyboard terminal"`
- Verify-type: e2e

**AC-08-3**: PTY passthrough
- Given: 터미널 포커스
- When: 일반 문자 키
- Then: PTY 전달
- Verify: `pnpm test:e2e -- --grep "Keyboard passthrough"`
- Verify-type: e2e

**AC-08-N1** (Negative): 단축키와 터미널 입력 충돌
- Given: 터미널에 포커스, 텍스트 선택 없음
- When: Ctrl+C를 누른다
- Then: SIGINT가 PTY에 전달된다 (Copy가 아님)
- Verify: `pnpm test:e2e -- --grep "Keyboard ctrl-c sigint"`
- Verify-type: e2e

---

## Layer 3 — Side Panels

### R-L3-01: Rail Component

ASR: none

좌측 48px. Files/Status/Network/Settings 4 아이콘.

**AC-01-1**: 레일 렌더링
- Given: App 렌더링
- When: Rail 표시
- Then: 4 아이콘 세로 배치, 48px
- Verify: `pnpm test -- --grep "Rail render"`
- Verify-type: component

**AC-01-2**: 패널 토글 열기
- Given: 패널 닫힘
- When: Rail 아이콘 클릭
- Then: 300px 패널 열림
- Verify: `pnpm test -- --grep "Rail toggle open"`
- Verify-type: component

**AC-01-3**: 패널 토글 닫기
- Given: 패널 열림 + 활성 아이콘
- When: 같은 아이콘 클릭
- Then: 패널 닫힘, 터미널 전체 너비
- Verify: `pnpm test -- --grep "Rail toggle close"`
- Verify-type: component

**AC-01-N1** (Negative): 패널 전환 시 이전 패널 정리
- Given: StatusPanel이 열려있다
- When: Network 아이콘을 클릭한다
- Then: StatusPanel collector가 중지되고 NetworkPanel이 열린다
- Verify: `pnpm test -- --grep "Rail switch panel"`
- Verify-type: component

---

### R-L3-02: useVisibilityLifecycle Hook

ASR: ASR-03

패널 가시성 + 윈도우 활성 → collector 시작/중지 (ADR-006).

**AC-02-1**: 패널 열기 → start
- Given: StatusPanel 닫힘
- When: Status 아이콘 클릭
- Then: metrics:start IPC
- Verify: `pnpm test -- --grep "visibility start"`
- Verify-type: component

**AC-02-2**: 패널 닫기 → stop
- Given: StatusPanel 열림
- When: Status 아이콘 클릭 닫기
- Then: metrics:stop IPC
- Verify: `pnpm test -- --grep "visibility stop"`
- Verify-type: component

**AC-02-3**: 윈도우 최소화 → stop
- Given: StatusPanel 열림
- When: 윈도우 최소화
- Then: collector 중지
- Verify: `pnpm test -- --grep "visibility minimize"`
- Verify-type: component

**AC-02-N1** (Negative): 빠른 토글 시 중복 시작 방지
- Given: 패널이 닫혀있다
- When: 100ms 이내에 열기/닫기/열기를 반복한다
- Then: collector가 정확히 1번만 시작된다 (중복 start 없음)
- Verify: `pnpm test -- --grep "visibility rapid toggle"`
- Verify-type: component

---

### R-L3-03: FilesPanel (CWD Explorer)

ASR: none

PTY CWD 감지 → 파일 트리 표시. 읽기 전용 + 가상 스크롤.

**AC-03-1**: CWD 감지 (OSC 7)
- Given: PTY OSC 7 출력
- When: CWD 추출
- Then: chokidar watcher 시작
- Verify: `pnpm test -- --grep "FilesPanel CWD OSC7"`
- Verify-type: unit

**AC-03-2**: Win32 CWD fallback
- Given: OSC 7 5초 미감지
- When: fallback 타이머 만료
- Then: NtQueryInformationProcess 폴링
- Verify: `pnpm test -- --grep "FilesPanel CWD fallback"`
- Verify-type: unit

**AC-03-3**: 파일 트리 렌더링
- Given: CWD + 파일 목록 로드
- When: FilesPanel 렌더링
- Then: 트리 + @tanstack/react-virtual 가상화
- Verify: `pnpm test -- --grep "FilesPanel tree"`
- Verify-type: component

**AC-03-4**: 실시간 감지
- Given: chokidar CWD 감시
- When: 파일 추가/삭제/변경
- Then: 트리 자동 갱신
- Verify: `pnpm test -- --grep "FilesPanel watch"`
- Verify-type: unit

**AC-03-N1** (Negative): 접근 불가
- Given: 접근 권한 없는 CWD
- When: 파일 목록 로드
- Then: "접근 권한 없음" 메시지
- Verify: `pnpm test -- --grep "FilesPanel access denied"`
- Verify-type: unit

---

### R-L3-04: File Preview (ezterm-file://)

ASR: ASR-08

파일 미리보기. text/image/HTML. CWD scope + whitelist.

**AC-04-1**: 텍스트 미리보기
- Given: .txt 선택
- When: 미리보기 활성
- Then: 텍스트 내용 표시
- Verify: `pnpm test -- --grep "Preview text"`
- Verify-type: component

**AC-04-2**: 이미지 미리보기
- Given: .png 선택
- When: ezterm-file:// 로드
- Then: 이미지 표시
- Verify: `pnpm test -- --grep "Preview image"`
- Verify-type: component

**AC-04-3**: Path traversal 차단
- Given: ".." 포함 경로
- When: 프로토콜 검증
- Then: 요청 거부
- Verify: `pnpm test -- --grep "Protocol traversal"`
- Verify-type: unit

**AC-04-N1** (Negative): 비허용 확장자
- Given: .exe 요청
- When: whitelist 검사
- Then: 거부
- Verify: `pnpm test -- --grep "Protocol extension blocked"`
- Verify-type: unit

**AC-04-N2** (Negative): 10MB 초과
- Given: 15MB 파일
- When: 크기 검사
- Then: "파일이 너무 큽니다"
- Verify: `pnpm test -- --grep "Preview size limit"`
- Verify-type: unit

---

### R-L3-05: StatusPanel (System Metrics)

ASR: ASR-03

systeminformation CPU/mem/disk/process/GPU. useVisibilityLifecycle.

**AC-05-1**: Metrics collector
- Given: metrics:start
- When: 2초 간격 폴링
- Then: CPU/mem/disk/GPU 수집
- Verify: `pnpm test -- --grep "Metrics collector"`
- Verify-type: unit

**AC-05-2**: Metrics push
- Given: 데이터 수집 완료
- When: metrics:update push
- Then: MetricsData renderer 전달
- Verify: `pnpm test -- --grep "Metrics push"`
- Verify-type: unit

**AC-05-3**: StatusPanel 렌더링
- Given: MetricsData store 업데이트
- When: StatusPanel 렌더링
- Then: CPU/mem/disk 정보 표시
- Verify: `pnpm test -- --grep "StatusPanel render"`
- Verify-type: component

**AC-05-N1** (Negative): SI 에러
- Given: systeminformation 실패
- When: 폴링 시도
- Then: 로그 + 다음 interval 재시도 (no crash)
- Verify: `pnpm test -- --grep "Metrics error resilience"`
- Verify-type: unit

---

### R-L3-06: NetworkPanel

ASR: ASR-06

Traffic/connection (항상) + capture/hexdump (Npcap).

**AC-06-1**: Npcap 감지
- Given: NetworkPanel 열기
- When: cap 모듈 로딩
- Then: npcapAvailable 플래그
- Verify: `pnpm test -- --grep "Network npcap detect"`
- Verify-type: unit

**AC-06-2**: 트래픽 통계
- Given: Npcap 미설치
- When: network:start
- Then: networkStats() rx/tx 수집
- Verify: `pnpm test -- --grep "Network traffic stats"`
- Verify-type: unit

**AC-06-3**: 연결 테이블
- Given: collector 활성
- When: 연결 수집
- Then: networkConnections() 프로토콜/주소/상태
- Verify: `pnpm test -- --grep "Network connections"`
- Verify-type: unit

**AC-06-4**: 패킷 캡처
- Given: Npcap 설치
- When: 캡처 시작
- Then: cap 실시간 캡처
- Verify: `pnpm test -- --grep "Network capture"`
- Verify-type: unit

**AC-06-5**: Npcap 미설치 UI
- Given: Npcap 미설치
- When: NetworkPanel 렌더링
- Then: 트래픽/연결 정상, 캡처 영역 "Npcap required" + 설치 링크
- Verify: `pnpm test -- --grep "Network npcap fallback UI"`
- Verify-type: component

**AC-06-N1** (Negative): 인터페이스 없음
- Given: 네트워크 인터페이스 없음
- When: 트래픽 수집
- Then: "네트워크 인터페이스 없음"
- Verify: `pnpm test -- --grep "Network no interface"`
- Verify-type: unit

---

### R-L3-07: SettingsPanel

ASR: ASR-07

설정 UI. 셸/폰트/모니터링/테마.

**AC-07-1**: 설정 로드
- Given: SettingsPanel 열기
- When: settings:load IPC
- Then: UserSettings 폼 표시
- Verify: `pnpm test -- --grep "Settings load"`
- Verify-type: component

**AC-07-2**: 설정 저장
- Given: 폰트 크기 변경
- When: 저장 클릭
- Then: settings:save IPC
- Verify: `pnpm test -- --grep "Settings save"`
- Verify-type: component

**AC-07-3**: 즉시 반영
- Given: fontSize 14→16
- When: 저장 완료
- Then: 모든 xterm.options.fontSize = 16
- Verify: `pnpm test -- --grep "Settings apply"`
- Verify-type: component

**AC-07-N1** (Negative): 잘못된 설정 값 거부
- Given: 사용자가 font size를 0으로 입력한다
- When: 저장을 시도한다
- Then: 유효성 검사 실패, 저장 거부, 에러 메시지 표시
- Verify: `pnpm test -- --grep "Settings validation"`
- Verify-type: component

---

### R-L3-08: Settings Persistence

ASR: ASR-07

main process atomic 읽기/쓰기.

**AC-08-1**: 파일 읽기
- Given: settings.json 존재
- When: settings:load
- Then: JSON 파싱 → IpcResult\<UserSettings\>
- Verify: `pnpm test -- --grep "Settings file load"`
- Verify-type: unit

**AC-08-2**: Atomic 쓰기
- Given: 설정 변경
- When: settings:save
- Then: .tmp → rename() 원자적 교체
- Verify: `pnpm test -- --grep "Settings atomic write"`
- Verify-type: unit

**AC-08-3**: 기본값 생성
- Given: settings.json 미존재
- When: settings:load
- Then: 기본 설정 생성 + 반환
- Verify: `pnpm test -- --grep "Settings default"`
- Verify-type: unit

**AC-08-N1** (Negative): 손상 JSON
- Given: 유효하지 않은 JSON
- When: settings:load
- Then: IpcResult { ok: false, code: "SETTINGS_CORRUPT" } + 기본값 복구
- Verify: `pnpm test -- --grep "Settings corrupt"`
- Verify-type: unit

---

## Layer 4 — Polish

### R-L4-01: Floating Panels

ASR: none

별도 BrowserWindow. Pop-out/dock round-trip.

**AC-01-1**: Pop-out
- Given: 메인 윈도우 패널 열림
- When: pop-out 클릭
- Then: 별도 BrowserWindow + 패널 이동
- Verify: `pnpm test:e2e -- --grep "Float pop-out"`
- Verify-type: e2e

**AC-01-2**: Dock
- Given: 플로팅 패널 열림
- When: dock 클릭
- Then: 플로팅 닫기 + 메인 복귀
- Verify: `pnpm test:e2e -- --grep "Float dock"`
- Verify-type: e2e

**AC-01-3**: 최소화 독립
- Given: 플로팅 + collector 활성
- When: 메인 윈도우 최소화
- Then: 플로팅 collector 유지
- Verify: `pnpm test:e2e -- --grep "Float minimize independent"`
- Verify-type: e2e

**AC-01-N1** (Negative): 강제 종료
- Given: 플로팅 열림
- When: X 버튼 닫기
- Then: 상태 closed + 리소스 정리
- Verify: `pnpm test:e2e -- --grep "Float force close"`
- Verify-type: e2e

---

### R-L4-02: Context Menu

ASR: none

터미널 우클릭 13항목. 키보드 네비게이션.

**AC-02-1**: 메뉴 표시
- Given: 터미널 포커스
- When: 우클릭
- Then: 13항목 커서 위치
- Verify: `pnpm test -- --grep "ContextMenu show"`
- Verify-type: component

**AC-02-2**: 키보드 네비게이션
- Given: 메뉴 열림
- When: Arrow + Enter
- Then: 선택 항목 실행
- Verify: `pnpm test -- --grep "ContextMenu keyboard"`
- Verify-type: component

**AC-02-3**: 화면 경계
- Given: 우하단 커서
- When: 우클릭
- Then: 화면 밖 방지
- Verify: `pnpm test -- --grep "ContextMenu overflow"`
- Verify-type: component

**AC-02-N1** (Negative): 선택 없이 Copy 비활성
- Given: 터미널에 텍스트 선택이 없다
- When: 컨텍스트 메뉴를 연다
- Then: Copy 항목이 비활성(disabled) 상태이다
- Verify: `pnpm test -- --grep "ContextMenu copy disabled"`
- Verify-type: component

---

### R-L4-03: Command Palette

ASR: none

Ctrl+Shift+P. 14 commands. Substring filter.

**AC-03-1**: 팔레트 표시
- Given: 앱 포커스
- When: Ctrl+Shift+P
- Then: 검색 + 14 명령
- Verify: `pnpm test:e2e -- --grep "Palette show"`
- Verify-type: e2e

**AC-03-2**: Substring 필터
- Given: 팔레트 열림
- When: "split" 입력
- Then: Split Right/Down만 표시
- Verify: `pnpm test -- --grep "Palette filter"`
- Verify-type: component

**AC-03-3**: 명령 실행
- Given: 항목 선택
- When: Enter
- Then: 명령 실행 + 팔레트 닫힘
- Verify: `pnpm test -- --grep "Palette execute"`
- Verify-type: component

**AC-03-N1** (Negative): 필터 결과 없음
- Given: Command palette가 열려있다
- When: 일치하는 명령이 없는 문자열을 입력한다
- Then: "일치하는 명령 없음" 메시지가 표시되고, Enter는 무동작
- Verify: `pnpm test -- --grep "Palette no match"`
- Verify-type: component

---

### R-L4-04: Save Scrollback

ASR: none

SerializeAddon plain text export + SaveAs.

**AC-04-1**: 내보내기
- Given: 터미널 내용 존재
- When: "Save Scrollback" 선택
- Then: serialize() → SaveAs dialog
- Verify: `pnpm test -- --grep "Scrollback save"`
- Verify-type: component

---

### R-L4-05: Find Bar

ASR: none

addon-search 터미널 내 검색.

**AC-05-1**: Find bar 표시
- Given: 터미널 포커스
- When: Ctrl+F
- Then: 검색 바 표시
- Verify: `pnpm test -- --grep "FindBar show"`
- Verify-type: component

**AC-05-2**: 검색 실행
- Given: Find bar 열림
- When: 검색어 입력
- Then: findNext() 하이라이트
- Verify: `pnpm test -- --grep "FindBar search"`
- Verify-type: component

**AC-05-3**: ESC 닫기
- Given: Find bar 열림
- When: ESC
- Then: Find bar 닫힘, 터미널 포커스
- Verify: `pnpm test -- --grep "FindBar close"`
- Verify-type: component

**AC-05-N1** (Negative): 검색 결과 없음
- Given: Find bar가 열려있다
- When: 터미널 내용에 없는 문자열을 검색한다
- Then: "No results" 표시, 하이라이트 없음
- Verify: `pnpm test -- --grep "FindBar no results"`
- Verify-type: component

---

## ADR References

| ADR | Title | Spec Impact |
|-----|-------|-------------|
| ADR-001 | Electron 3-layer + typed IPC | Architecture baseline |
| ADR-002 | xterm.js full delegation | R-L1-06 |
| ADR-003 | 16ms PTY frame coalescing | R-L1-03 |
| ADR-004 | Custom SplitContainer | R-L2-04 |
| ADR-005 | Persist xterm via display:none | R-L1-06, R-L2-02 |
| ADR-006 | Visibility lifecycle | R-L3-02 |
| ADR-007 | Npcap graceful degradation | R-L3-06 |
| ADR-008 | OSC 7 CWD detection | R-L3-03 |
| ADR-009 | Custom file protocol | R-L3-04 |
