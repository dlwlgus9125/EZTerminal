---
doc_type: spec
authority: derived
status: approved
created: 2026-05-14
spec_id: spec-1
---

# Spec 1: Terminal Shell

Electron 기반 터미널 에뮬레이터의 핵심 — 프로젝트 구조, PTY 관리, xterm.js 렌더링, 다중 탭/분할, 데스크톱 UX, 앱 라이프사이클.

## Architecture Baseline

### Selected Approach

Electron 3-layer architecture: main (Node.js) / preload (contextBridge) / renderer (React + xterm.js). xterm.js에 VT 렌더링 전적 위임, node-pty로 PTY 관리, Zustand 슬라이스로 상태 관리.

### Boundary Map

| Module | Interface | Allowed Deps | Forbidden Deps | Data Ownership |
|--------|-----------|-------------|----------------|----------------|
| main/pty | PtyManager: create/write/resize/kill | node-pty | React, xterm.js | PTY sessions |
| main/ipc | IPC channel handlers | main/* modules | renderer modules | Message routing |
| main/settings | SettingsService: load/save | fs (Node.js) | React | Settings JSON |
| main/window | WindowManager: createMain/createFloating | electron | React | BrowserWindow refs |
| preload/api | ElectronAPI typed interface | electron (contextBridge) | main modules directly | None |
| renderer/stores | Zustand slices (tab, settings) | zustand, preload/api | Node.js, electron | UI state |
| renderer/terminal | TerminalView: mount/dispose | xterm.js, @xterm/addon-* | Node.js | Terminal buffer |
| renderer/components | React component tree | renderer/stores, renderer/terminal | Node.js | None |

### Existing Constraints

- ADR-001: Electron 3-layer + typed IPC
- ADR-002: xterm.js full delegation
- ADR-003: 16ms PTY data frame coalescing
- ADR-004: Custom SplitContainer over allotment

## ASR Ledger

| ASR | Quality Attribute | Target | Design Impact | Verification |
|-----|-------------------|--------|---------------|-------------|
| ASR-1 | Performance | key-to-pty < 16ms | Typed IPC, no middleware in hot path | `pnpm test:e2e --grep "input-latency"` |
| ASR-2 | Performance | startup < 3s | Lazy panel creation, deferred addon loading | `pnpm test:e2e --grep "startup-time"` |
| ASR-3 | Performance | monitoring-update < 100ms | Debounced metric push, Zustand selectors, requestAnimationFrame chart | `pnpm test -- --run --grep "metrics-update-latency"` |
| ASR-4 | Performance | bundle < 15MB | Vite tree-shaking, code splitting | `node -e "const s=require('fs').statSync('out');if(s.size>15e6)process.exit(1)"` |
| ASR-5 | Reliability | Zero PTY leaks | Pane lifecycle owns create/destroy | `pnpm test -- --run --grep "pty-leak"` |
| ASR-6 | Reliability | Graceful shutdown ≤ 5s | Sequential shutdown sequence | `pnpm test:e2e --grep "shutdown"` |
| ASR-7 | Reliability | WebGL failure recovery | Canvas 2D auto-fallback | `pnpm test -- --run --grep "webgl-fallback"` |
| ASR-8 | Security | No Node.js in renderer | contextBridge only | `bash -c '! grep -r "require(" src/renderer/ --include="*.ts" --include="*.tsx"'` |

## Option Matrix

| Decision | Selected | Rejected | Rejection Reason |
|----------|----------|----------|-----------------|
| Split layout | Custom SplitContainer (CSS Grid) | allotment | Flat model, cannot represent asymmetric binary tree |
| IPC data flow | 16ms frame coalescing | Per-write IPC | Floods IPC bridge; VS Code validates coalescing |
| Terminal lifecycle | Persist (display:none) | Recreate on switch | Recreation delay; WebGL limit > practical tab count |
| Floating panels | BrowserWindow | CSS overlay | Multi-monitor requires real window |
| State management | Zustand 5 slices | Redux / Jotai | Minimal boilerplate, slice isolation |
| Linting | Biome | ESLint + Prettier | Single tool, faster, less config |
| Theme structure | `[data-theme]` attribute | :root direct | Supports future light mode |

## Lifecycle And Operations

| Aspect | Design |
|--------|--------|
| Lifecycle stage | Production — feature spec verified in BAK |
| Startup | main → BrowserWindow → preload → renderer mount → first PTY → ready |
| Shutdown | before-quit → 5s graceful PTY → force kill → save settings → quit |
| Deployment | Electron Forge package (Squirrel.Windows) |
| Migration | Settings JSON versioned; migration fn per bump |
| Observability | console in dev; electron-log in prod |
| Recovery | WebGL→Canvas fallback; PTY crash→restart in pane |
| Ownership | Single developer, local desktop |

## Quality Budgets

| Quality | Budget | Risk |
|---------|--------|------|
| Performance | startup <3s, key-to-pty <16ms, bundle <15MB | Lag vs Windows Terminal |
| Reliability | Zero PTY leaks, shutdown ≤5s, WebGL fallback | Zombie processes, data loss |
| Security | No nodeIntegration, contextBridge only | RCE via terminal output |
| Cost | None declared | Risk: none (local desktop) |
| Maintainability | Biome zero warnings, TS strict | Tech debt in solo project |

## Wiring Map

| ID | Aspect | Value |
|----|--------|-------|
| WM-EP1 | Entry point | `main()` in `src/main/index.ts` — Electron app bootstrap |
| WM-EP2 | Entry point | `createRoot()` in `src/renderer/index.tsx` — React mount |
| WM-REG1 | Registration | IPC handlers registered in `src/main/ipc/index.ts` via `ipcMain.handle()` for pty:create, pty:write, pty:resize; `ipcMain.on()` for pty:data, pty:exit |
| WM-REG2 | Registration | Preload API exposed in `src/preload/index.ts` via `contextBridge.exposeInMainWorld('electronAPI', {...})` |
| WM-REG3 | Registration | Zustand stores created in `src/renderer/stores/index.ts` — tabSlice, settingsSlice, uiSlice |
| WM-REG4 | Registration | xterm.js Terminal + addons loaded in `src/renderer/terminal/TerminalView.ts` — WebGLAddon, FitAddon, Unicode11Addon, SearchAddon |
| WM-DF1 | Data flow | Keystroke → xterm.js `onData` → `electronAPI.pty.write(sessionId, data)` → preload IPC → `ipcMain.handle('pty:write')` → `PtyManager.write(sessionId, data)` → node-pty stdin |
| WM-DF2 | Data flow | PTY stdout → 16ms coalescer (Buffer[]) → `mainWindow.webContents.send('pty:data', sessionId, coalesced)` → preload listener → `electronAPI.pty.onData` callback → `terminal.write(data)` |
| WM-DF3 | Data flow | Container ResizeObserver → FitAddon.fit() → cols/rows change → 100ms debounce → `electronAPI.pty.resize(sessionId, cols, rows)` → `ipcMain.handle('pty:resize')` → `pty.resize(cols, rows)` |
| WM-DF4 | Data flow | Settings change (renderer) → `electronAPI.settings.save(settings)` → `ipcMain.handle('settings:save')` → SettingsService.save() → atomic .tmp→rename |
| WM-C1 | Contract | `PtyManager.create(shellPath?: string): { sessionId: string }` |
| WM-C2 | Contract | `PtyManager.write(sessionId: string, data: string): void` |
| WM-C3 | Contract | `PtyManager.resize(sessionId: string, cols: number, rows: number): void` |
| WM-C4 | Contract | `PtyManager.kill(sessionId: string): Promise<void>` |
| WM-C5 | Contract | `PtyManager.killAll(timeoutMs?: number): Promise<void>` |
| WM-C6 | Contract | `SettingsService.load(): Settings` |
| WM-C7 | Contract | `SettingsService.save(settings: Settings): void` |
| WM-C8 | Contract | `WindowManager.createMain(): BrowserWindow` |
| WM-C9 | Contract | `WindowManager.createFloating(panelId: string): BrowserWindow` |
| WM-C10 | Contract | `ElectronAPI.pty.create(shellPath?: string): Promise<{ sessionId: string }>` |
| WM-C11 | Contract | `ElectronAPI.pty.write(sessionId: string, data: string): Promise<void>` |
| WM-C12 | Contract | `ElectronAPI.pty.resize(sessionId: string, cols: number, rows: number): Promise<void>` |
| WM-C13 | Contract | `ElectronAPI.pty.onData(callback: (sessionId: string, data: string) => void): void` |
| WM-C14 | Contract | `ElectronAPI.pty.onExit(callback: (sessionId: string, exitCode: number) => void): void` |
| WM-C15 | Contract | `ElectronAPI.settings.load(): Promise<Settings>` |
| WM-C16 | Contract | `ElectronAPI.settings.save(settings: Settings): Promise<void>` |

## Initialization Order

| Order | Module | Prerequisite | Readiness Signal |
|-------|--------|-------------|------------------|
| 1 | main/pty | None | PtyManager instance created |
| 2 | main/settings | fs access | Settings JSON loaded or defaults applied |
| 3 | main/ipc | main/pty, main/settings | All ipcMain.handle() calls registered |
| 4 | main/window | Electron app.whenReady() + main/ipc | BrowserWindow 'ready-to-show' event |
| 5 | preload/api | main/ipc registered | contextBridge.exposeInMainWorld() complete |
| 6 | renderer/stores | preload/api available (window.electronAPI) | Zustand stores initialized with initial data |
| 7 | renderer/terminal | renderer/stores + preload/api | First TerminalView mounted, PTY session active |

## Decision Log

| # | Decision | ADR | Reason |
|---|----------|-----|--------|
| 1 | Electron 3-layer + typed IPC | ADR-001 | Hard to reverse, shapes all boundaries |
| 2 | xterm.js full delegation | ADR-002 | Eliminates custom VT parser |
| 3 | 16ms frame coalescing | ADR-003 | Performance architecture |
| 4 | Custom SplitContainer | ADR-004 | Surprising library rejection |
| 5 | Persist xterm instances (display:none) | ADR-005 | Hard-to-reverse: WebGL context limit constraint, tab strategy dependency |
| 6 | Zustand slices | No | Swappable |
| 7 | Biome | No | Trivially reversible |
| 8 | `[data-theme]` tokens | No | Easy to reverse |
| 9 | Ctrl+Shift+P palette | No | Keybinding, trivially changeable |
| 10 | Visibility lifecycle pattern | ADR-006 | Cross-spec: collector start/stop bound to panel visibility, shared by Spec 2 & 3 |
| 11 | Npcap graceful degradation | ADR-007 | Two data-source paths with different fidelity; native privilege dependency |

## Requirements

### R1: Electron 프로젝트 구조

**ASR:** ASR-2, ASR-4, ASR-8
**Input:** `pnpm create electron-app` scaffold
**Behavior:**
1. Electron Forge v7 + Vite plugin으로 프로젝트 초기화
2. `src/main/`, `src/preload/`, `src/renderer/` 3계층 분리
3. TypeScript 5.7 strict + noUncheckedIndexedAccess
4. Phosphor 17 CSS tokens을 `[data-theme='dark']` 하에 선언
5. electron-rebuild postinstall hook으로 node-pty + cap 리빌드
6. Biome config for lint + format
**Output:** 빌드 성공, 빈 Electron 창 표시
**Impact scope:**
- 전체 프로젝트: 디렉토리 구조, 빌드 파이프라인, 테마 기반
**Acceptance criteria:**
- [ ] Given: 빈 프로젝트 디렉토리
      When: `pnpm install && pnpm build` 실행
      Then: 빌드 성공, `out/` 디렉토리에 패키징된 앱 생성
      Verify: `pnpm build && test -d out`
      Verify-type: cli
      Automatable: true
- [ ] Given: 빌드된 프로젝트
      When: TypeScript strict 검사 실행
      Then: 타입 에러 0건
      Verify: `pnpm exec tsc --noEmit`
      Verify-type: cli
      Automatable: true
- [ ] Given: src/renderer/ 디렉토리
      When: Node.js require 패턴 검색
      Then: 0건 매치
      Verify: `bash -c '! grep -rn "require(" src/renderer/ --include="*.ts" --include="*.tsx"'`
      Verify-type: cli
      Automatable: true
- [ ] Given: 프로젝트 소스
      When: Biome 검사 실행
      Then: 경고/에러 0건
      Verify: `pnpm lint`
      Verify-type: cli
      Automatable: true
**Edge cases:**
- electron-rebuild 실패 시: 에러 메시지에 Visual Studio Build Tools 설치 안내 포함

### R2: PTY 세션 관리

**ASR:** ASR-1, ASR-5
**Input:** 탭/페인 생성 요청 (IPC `pty:create`)
**Behavior:**
1. PtyManager가 node-pty로 새 PTY 프로세스 생성 (UUID session ID)
2. 셸 경로는 Settings에서 읽거나 OS 기본값 감지 (PowerShell → cmd 폴백)
3. PTY stdout을 16ms 프레임으로 합쳐서 `pty:data` IPC로 renderer에 전달
4. `pty:write` IPC로 사용자 입력을 PTY stdin에 전달
5. `pty:resize` IPC로 cols/rows 변경 전달
6. PTY 종료 시 `pty:exit` IPC로 exit code 전달
**Output:** PTY 세션 생성/통신/종료 정상 동작
**Impact scope:**
- main/pty: PtyManager 구현
- main/ipc: 5개 채널 등록
- preload/api: 5개 메서드 노출
**Acceptance criteria:**
- [ ] Given: 앱 시작 상태
      When: 새 탭 생성
      Then: PTY 프로세스 생성되고 UUID 부여, 셸 프롬프트 표시
      Verify: `pnpm test -- --run --grep "pty-create"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 활성 PTY 세션
      When: 텍스트 입력
      Then: PTY stdin에 전달되고 echo 출력이 16ms 이내에 renderer 도착
      Verify: `pnpm test -- --run --grep "pty-write-echo"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 활성 PTY 세션
      When: 셸 프로세스 종료 (exit 명령)
      Then: pty:exit 이벤트 발생, exit code 전달
      Verify: `pnpm test -- --run --grep "pty-exit"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 여러 PTY 세션 생성 후
      When: 모든 세션 dispose
      Then: 남은 PTY 프로세스 0개
      Verify: `pnpm test -- --run --grep "pty-leak"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 셸 경로가 존재하지 않을 때: cmd.exe 폴백
- PTY 생성 실패 시: 에러 메시지를 renderer에 전달

### R3: xterm.js 터미널 렌더링

**ASR:** ASR-1, ASR-7
**Input:** PTY 데이터 (pty:data IPC)
**Behavior:**
1. xterm.js Terminal 인스턴스 생성, WebGL addon 로드 시도
2. WebGL 실패 (webglcontextlost) 시 Canvas 2D addon으로 자동 폴백
3. addon-fit로 컨테이너 크기에 맞춰 cols/rows 자동 계산
4. addon-unicode11로 한글/이모지 올바른 폭 계산
5. scrollback 20,000줄
6. Phosphor 토큰에서 xterm.js theme 객체 생성
**Output:** VT 시퀀스가 xterm.js 버퍼에 기록되고 스크롤백 라인 수 증가
**Impact scope:**
- renderer/terminal: TerminalView 컴포넌트
- renderer/styles: Phosphor → xterm.js theme 매핑
**Acceptance criteria:**
- [ ] Given: TerminalView 마운트
      When: PTY 데이터 수신
      Then: xterm.js에 렌더링되고 스크롤백 유지
      Verify: `pnpm test -- --run --grep "terminal-render"`
      Verify-type: lib
      Automatable: true
- [ ] Given: WebGL 초기화 실패 환경
      When: TerminalView 마운트
      Then: Canvas 2D 렌더러로 폴백, 기능 동일
      Verify: `pnpm test -- --run --grep "webgl-fallback"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 터미널에 한글/이모지 출력
      When: 유니코드 확장 폭 계산이 활성화된 상태에서 렌더링
      Then: 한글이 2셀, 이모지가 2셀 폭으로 렌더링
      Verify: `pnpm test -- --run --grep "unicode-width"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- webglcontextlost 이벤트 발생 시: 즉시 Canvas 2D 전환, 사용자 알림 없이 무중단

### R4: 키보드 입력 처리

**ASR:** ASR-1
**Input:** 사용자 키보드 이벤트
**Behavior:**
1. xterm.js `attachCustomKeyEventHandler`로 앱 단축키 가로채기
2. 앱 단축키(Ctrl+T, Ctrl+Shift+D 등): 이벤트 소비, 앱 동작 실행
3. 나머지 키: xterm.js → PTY로 전달
4. Ctrl+C: 선택 영역 있으면 복사, 없으면 SIGINT 전달
5. Ctrl+V: 클립보드 → PTY 붙여넣기 (bracketed paste mode 지원)
**Output:** 앱 단축키는 앱이 처리, 나머지는 PTY에 도달
**Impact scope:**
- renderer/terminal: 키 핸들러 등록
- renderer/stores: 단축키 → 액션 매핑
**Acceptance criteria:**
- [ ] Given: 활성 터미널 포커스
      When: Ctrl+T 입력
      Then: 새 탭 생성 (PTY에 전달되지 않음)
      Verify: `pnpm test -- --run --grep "key-intercept-app"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 활성 터미널 포커스
      When: 일반 문자/화살표/Tab 입력
      Then: PTY stdin에 올바른 바이트 전달
      Verify: `pnpm test -- --run --grep "key-passthrough-pty"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 선택 영역 있는 터미널
      When: Ctrl+C 입력
      Then: 선택 텍스트 클립보드 복사 (SIGINT 전달 안 됨)
      Verify: `pnpm test -- --run --grep "ctrl-c-copy"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 선택 영역 없는 터미널
      When: Ctrl+C 입력
      Then: SIGINT(\x03) PTY에 전달
      Verify: `pnpm test -- --run --grep "ctrl-c-sigint"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 포커스가 Find bar/팔레트에 있을 때: 키 이벤트가 터미널에 도달하지 않아야 함

### R5: 리사이즈 처리

**ASR:** none
**Input:** 컨테이너 크기 변경 (창 크기 조절, 패널 토글, 분할 비율 변경)
**Behavior:**
1. addon-fit가 새 cols/rows 계산
2. 이전과 동일하면 무시
3. 변경 시 100ms 디바운스 후 IPC pty:resize 전송
4. PTY가 새 크기로 업데이트
**Output:** 터미널과 PTY의 cols/rows 동기화
**Impact scope:**
- renderer/terminal: fit addon + 디바운스 로직
- main/pty: resize 핸들러
**Acceptance criteria:**
- [ ] Given: 활성 터미널
      When: 창 크기 조절로 cols/rows 변경
      Then: 100ms 디바운스 후 PTY resize 호출
      Verify: `pnpm test -- --run --grep "resize-debounce"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 활성 터미널 (80x24)
      When: 패널 토글로 cols만 변경
      Then: 새 cols로 PTY resize
      Verify: `pnpm test -- --run --grep "resize-panel-toggle"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 활성 터미널 (80x24)
      When: 같은 크기로 resize 트리거
      Then: PTY resize 호출 안 됨
      Verify: `pnpm test -- --run --grep "resize-same-size-skip"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 빠른 연속 리사이즈: 디바운스로 마지막 값만 적용

### R6: 다중 탭 관리

**ASR:** none
**Input:** 사용자 탭 조작 (단축키/UI)
**Behavior:**
1. Ctrl+T: 새 탭 생성 (새 PTY 세션 + 단일 페인)
2. Ctrl+Tab / Ctrl+Shift+Tab: 탭 순환
3. Ctrl+1~9: 직접 탭 이동 (Ctrl+9 = 마지막)
4. 탭 닫기: 마지막 탭이면 차단, 아니면 모든 페인 dispose 후 탭 제거
5. Zustand tabSlice에서 상태 관리
**Output:** 탭 생성/전환/닫기 동작
**Impact scope:**
- renderer/stores: tabSlice
- renderer/components: TabBar 컴포넌트
**Acceptance criteria:**
- [ ] Given: 탭 1개 활성
      When: Ctrl+T
      Then: 탭 2개, 새 탭 활성, 새 PTY 세션 생성
      Verify: `pnpm test -- --run --grep "tab-create"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 탭 3개, 2번 활성
      When: Ctrl+Tab
      Then: 3번 탭 활성
      Verify: `pnpm test -- --run --grep "tab-cycle-next"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 탭 1개만 존재
      When: 탭 닫기 시도
      Then: 닫기 차단, 탭 유지
      Verify: `pnpm test -- --run --grep "tab-last-block"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 탭 3개
      When: Ctrl+9
      Then: 마지막(3번) 탭 활성
      Verify: `pnpm test -- --run --grep "tab-direct-last"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Ctrl+8 입력 시 탭이 3개뿐이면: 무시 (범위 초과)

### R7: 이진 트리 페인 분할

**ASR:** none
**Input:** 분할 요청 (Ctrl+Shift+D/E)
**Behavior:**
1. LayoutNode 타입: LeafNode (pane ID) | SplitNode (orientation, ratio, first, second)
2. 최대 4페인 제한 (분할 시도 시 검증)
3. 순수 함수 헬퍼: split, remove, find, resize, zoom, flatten
4. Immer 없이 immutable 업데이트
**Output:** 이진 트리 구조로 페인 배치
**Impact scope:**
- renderer/stores: layoutHelpers (순수 함수)
- renderer/stores: tabSlice (LayoutNode 저장)
**Acceptance criteria:**
- [ ] Given: 단일 페인 트리
      When: 해당 페인을 horizontal 방향으로 분할 요청
      Then: 두 자식을 가진 horizontal 분할 노드 생성, 비율 0.5
      Verify: `pnpm test -- --run --grep "layout-split"`
      Verify-type: pure
      Automatable: true
- [ ] Given: 4페인 트리
      When: split 시도
      Then: null 반환 (최대 제한)
      Verify: `pnpm test -- --run --grep "layout-max-panes"`
      Verify-type: pure
      Automatable: true
- [ ] Given: 3페인 트리
      When: 중간 페인을 트리에서 제거 요청
      Then: 2페인 트리, 나머지 비율 재조정
      Verify: `pnpm test -- --run --grep "layout-remove"`
      Verify-type: pure
      Automatable: true
- [ ] Given: 임의 깊이의 분할 트리
      When: 트리의 모든 페인 ID를 평탄화 요청
      Then: 모든 페인 ID를 배열로 반환
      Verify: `pnpm test -- --run --grep "layout-flatten"`
      Verify-type: pure
      Automatable: true
**Edge cases:**
- null root에 split: 새 LeafNode 반환
- 마지막 페인 remove: null 반환 (호출자가 처리)

### R8: 커스텀 SplitContainer

**ASR:** none
**Input:** LayoutNode 트리
**Behavior:**
1. LeafNode → 터미널 뷰 렌더링
2. SplitNode → CSS Grid로 두 자식을 orientation 방향 분할
3. 6px gutter: 드래그로 ratio 변경, 더블클릭으로 50:50 리셋
4. 재귀적으로 트리 전체를 렌더링
5. 트리 변경 시 고아 pane(트리에서 제거된 pane) 감지 및 dispose
**Output:** 페인 레이아웃 UI
**Impact scope:**
- renderer/components: SplitContainer 컴포넌트
**Acceptance criteria:**
- [ ] Given: SplitNode(horizontal, 0.5)
      When: SplitContainer 렌더
      Then: 두 페인이 동일 비율로 가로 배치되고 6px 구분선이 그 사이에 표시됨
      Verify: `pnpm test -- --run --grep "split-render-horizontal"`
      Verify-type: lib
      Automatable: true
- [ ] Given: gutter 드래그
      When: 마우스 이동 100px 오른쪽
      Then: ratio 업데이트, 리렌더
      Verify: `pnpm test -- --run --grep "split-gutter-drag"`
      Verify-type: lib
      Automatable: true
- [ ] Given: gutter
      When: 더블클릭
      Then: ratio 0.5로 리셋
      Verify: `pnpm test -- --run --grep "split-gutter-reset"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 깊이 3 트리 (4페인): 3중 재귀 CSS Grid 중첩

### R9: 페인 포커스 및 줌

**ASR:** none
**Input:** 클릭 또는 Ctrl+Alt+Arrow / Ctrl+Shift+Z
**Behavior:**
1. 페인 클릭: 해당 페인 활성 (xterm.js focus)
2. Ctrl+Alt+Arrow: 인접 페인으로 포커스 이동 (트리 탐색)
3. Ctrl+Shift+Z: 줌 토글 — 활성 페인만 표시, 나머지 display:none
4. 줌 중 분할 요청: 차단
5. 줌 해제 시 이전 레이아웃 복원
**Output:** 포커스/줌 상태 변경
**Impact scope:**
- renderer/stores: tabSlice (activePaneId, zoomedPaneId)
- renderer/components: SplitContainer (줌 렌더링)
**Acceptance criteria:**
- [ ] Given: 2페인, 왼쪽 활성
      When: 오른쪽 페인 클릭
      Then: 오른쪽 활성, xterm.js focus
      Verify: `pnpm test -- --run --grep "pane-focus-click"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 2페인 horizontal, 왼쪽 활성
      When: Ctrl+Alt+Right
      Then: 오른쪽 활성
      Verify: `pnpm test -- --run --grep "pane-focus-arrow"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 2페인
      When: Ctrl+Shift+Z
      Then: 활성 페인만 보임, 비활성 페인 display:none (PTY 유지)
      Verify: `pnpm test -- --run --grep "pane-zoom-toggle"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 줌 상태
      When: Ctrl+Shift+D (분할 시도)
      Then: 차단, 변화 없음
      Verify: `pnpm test -- --run --grep "pane-zoom-block-split"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 단일 페인에서 줌: 무시 (이미 전체 표시)

### R10: 페인 라이프사이클

**ASR:** ASR-5
**Input:** 분할 생성 / 셸 종료 / 페인 닫기
**Behavior:**
1. 분할 → 새 PTY 생성 (PtyManager.create)
2. 셸 종료 (pty:exit) → 자동 페인 닫기
3. 마지막 탭의 마지막 페인 셸 종료 → 새 셸 재시작 (탭 유지)
4. Ctrl+Shift+W → 활성 페인 닫기 (마지막 탭의 마지막 페인이면 차단)
5. async dispose: xterm.js dispose → PTY kill → 상태 정리
**Output:** 페인-PTY 라이프사이클 일관성 유지
**Impact scope:**
- renderer/stores: tabSlice (pane state management)
- renderer/terminal: dispose logic
- main/pty: kill handler
**Acceptance criteria:**
- [ ] Given: 활성 페인
      When: 셸이 `exit` 명령으로 종료
      Then: 페인 자동 닫히고 PTY 세션 정리
      Verify: `pnpm test -- --run --grep "pane-shell-exit"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 마지막 탭의 마지막 페인
      When: 셸 종료
      Then: 새 셸로 페인 재시작 (탭 유지)
      Verify: `pnpm test -- --run --grep "pane-last-restart"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 2페인
      When: Ctrl+Shift+W
      Then: 활성 페인 닫기, PTY dispose, 남은 페인 전체 표시
      Verify: `pnpm test -- --run --grep "pane-close-dispose"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 여러 페인 생성/닫기 반복
      When: 전체 dispose 후
      Then: PTY 프로세스 0개 잔존
      Verify: `pnpm test -- --run --grep "pty-leak"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- PTY kill 타임아웃: 5초 후 force kill

### R11: 데스크톱 쉘 레이아웃

**ASR:** none
**Input:** 앱 시작
**Behavior:**
1. TitleBar 32px: 앱 로고, 이름, 버전, 세션 카운터, 창 컨트롤 (최소화/최대화/닫기)
2. TabBar 36px: 탭 목록, 활성 표시, 닫기 버튼, SplitIndicator
3. Content: Terminal | Rail 48px | Panel 300px
4. StatusBar 22px: 셸 이름, 터미널 크기, 인코딩, 커맨드 팔레트 링크
5. Phosphor 테마 적용 (`[data-theme='dark']`)
**Output:** 레이아웃 정확히 렌더링
**Impact scope:**
- renderer/components: MainLayout, TitleBar, TabBar, StatusBar
- renderer/styles: 레이아웃 CSS
**Acceptance criteria:**
- [ ] Given: 앱 시작
      When: 메인 윈도우 렌더링
      Then: TitleBar 32px, TabBar 36px, StatusBar 22px, Rail 48px 확인
      Verify: `pnpm test:e2e --grep "layout-dimensions"`
      Verify-type: e2e
      Automatable: true
- [ ] Given: 메인 윈도우
      When: 패널 숨김 상태
      Then: Terminal이 Rail 옆 전체 폭 사용
      Verify: `pnpm test:e2e --grep "layout-panel-hidden"`
      Verify-type: e2e
      Automatable: true
**Edge cases:**
- 최소 창 크기: 800x600 이하로 축소 불가

### R12: Rail 패널 시스템

**ASR:** none
**Input:** Rail 아이콘 클릭
**Behavior:**
1. Rail: 4개 아이콘 (Files disabled, Status, Network, Settings)
2. 비활성 패널 클릭 → 패널 열기 (lazy 생성)
3. 활성 패널 재클릭 → 패널 접기
4. 다른 패널 클릭 → 패널 전환
**Output:** 패널 표시/숨김
**Impact scope:**
- renderer/components: RailBar, PanelContainer
- renderer/stores: uiSlice (activePanel)
**Acceptance criteria:**
- [ ] Given: 패널 닫힌 상태
      When: Status 아이콘 클릭
      Then: Status 패널 300px 열림
      Verify: `pnpm test -- --run --grep "rail-open-panel"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Status 패널 열린 상태
      When: Status 아이콘 재클릭
      Then: 패널 접힘
      Verify: `pnpm test -- --run --grep "rail-collapse"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Status 패널 열린 상태
      When: Network 아이콘 클릭
      Then: Network 패널로 전환
      Verify: `pnpm test -- --run --grep "rail-switch-panel"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Files 아이콘: disabled 상태, 클릭 무시

### R13: 컨텍스트 메뉴

**ASR:** none
**Input:** 터미널 우클릭
**Behavior:**
1. 커스텀 React 메뉴 표시 (12 항목):
   Copy, Paste, Paste & Run, separator, Find, Save Scrollback, Clear, Reset Shell, Kill Process, separator, Split Right, Split Down, Close Pane
2. 외부 클릭 / ESC → 닫기
3. 키보드 내비게이션 (↑↓ + Enter)
4. Phosphor 스타일링
**Output:** 컨텍스트 메뉴 동작
**Impact scope:**
- renderer/components: ContextMenu
**Acceptance criteria:**
- [ ] Given: 활성 터미널
      When: 우클릭
      Then: 12항목 커스텀 메뉴 표시
      Verify: `pnpm test -- --run --grep "context-menu-show"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 열린 메뉴
      When: ESC 또는 외부 클릭
      Then: 메뉴 닫힘
      Verify: `pnpm test -- --run --grep "context-menu-close"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 열린 메뉴
      When: Copy 클릭
      Then: 선택 텍스트 클립보드 복사, 메뉴 닫힘
      Verify: `pnpm test -- --run --grep "context-menu-copy"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 화면 가장자리 우클릭: 메뉴가 화면 밖으로 나가지 않도록 위치 조정

### R14: Find bar

**ASR:** none
**Input:** Ctrl+F
**Behavior:**
1. 터미널 상단 오버레이 입력 바 표시
2. addon-search로 스크롤백 + 현재 버퍼 검색
3. 매치 카운트 표시 (N/M)
4. Enter/Shift+Enter: 다음/이전 매치
5. 토글: 정규식, 대소문자 구분, 전체 단어
6. ESC: Find bar 닫기, 터미널 포커스 복귀
**Output:** 터미널 내 텍스트 검색
**Impact scope:**
- renderer/components: FindBar
- renderer/terminal: addon-search 연결
**Acceptance criteria:**
- [ ] Given: 활성 터미널
      When: Ctrl+F
      Then: Find bar 표시, 입력 필드 포커스
      Verify: `pnpm test -- --run --grep "find-bar-open"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Find bar에 "test" 입력
      When: 스크롤백에 "test" 3건 존재
      Then: 매치 카운트 "1/3" 표시, 첫 매치 하이라이트
      Verify: `pnpm test -- --run --grep "find-bar-count"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Find bar 열린 상태
      When: ESC
      Then: Find bar 닫히고 터미널 포커스 복귀
      Verify: `pnpm test -- --run --grep "find-bar-close"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 매치 0건: "0/0" 표시
- 정규식 문법 에러: 빨간색 테두리, 검색 중단

### R15: 커맨드 팔레트

**ASR:** none
**Input:** Ctrl+Shift+P
**Behavior:**
1. 오버레이 입력 필드 + 명령 목록
2. 14 명령: New Tab, Close Tab, Split Right, Split Down, Close Pane, Toggle Zoom, Focus Next Pane, Toggle Status, Toggle Network, Toggle Settings, Find, Clear Terminal, Reset Shell, Kill Process
3. Substring 필터링 (대소문자 무시)
4. Enter: 선택 명령 실행
5. ESC: 팔레트 닫기, 이전 포커스 복귀
**Output:** 명령 실행 UI
**Impact scope:**
- renderer/components: CommandPalette
**Acceptance criteria:**
- [ ] Given: 앱 활성
      When: Ctrl+Shift+P
      Then: 팔레트 표시, 14 명령 목록
      Verify: `pnpm test -- --run --grep "palette-open"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 팔레트 열림
      When: "spl" 입력
      Then: "Split Right", "Split Down" 필터링
      Verify: `pnpm test -- --run --grep "palette-filter"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 팔레트에서 "New Tab" 선택
      When: Enter
      Then: 새 탭 생성, 팔레트 닫힘
      Verify: `pnpm test -- --run --grep "palette-execute"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 빈 필터: 전체 14 명령 표시

### R16: 플로팅 패널

**ASR:** none
**Input:** 패널 팝아웃 버튼
**Behavior:**
1. 새 BrowserWindow 생성 (패널 내용 전용)
2. 팝아웃 후 메인 윈도우의 해당 패널 슬롯 비움
3. 독(Dock) 버튼으로 메인 윈도우에 복귀
4. 메인↔플로팅 간 IPC broadcast로 상태 동기화
5. 플로팅 윈도우 가시성에 따라 collector 시작/중지
**Output:** 멀티 모니터 패널 사용
**Impact scope:**
- main/window: WindowManager floating 관리
- main/ipc: broadcast 채널
- renderer/components: PanelHost (메인/플로팅 공유)
**Acceptance criteria:**
- [ ] Given: Status 패널 열림
      When: 팝아웃 버튼 클릭
      Then: 새 BrowserWindow에 Status 패널, 메인 윈도우 패널 슬롯 비움
      Verify: `pnpm test:e2e --grep "floating-popout"`
      Verify-type: e2e
      Automatable: true
- [ ] Given: 플로팅 Status 패널
      When: 독 버튼 클릭
      Then: 메인 윈도우에 Status 복귀, 플로팅 윈도우 닫힘
      Verify: `pnpm test:e2e --grep "floating-dock"`
      Verify-type: e2e
      Automatable: true
- [ ] Given: 플로팅 Status 패널
      When: 플로팅 윈도우 최소화
      Then: metrics 수집 중지
      Verify: `pnpm test -- --run --grep "floating-visibility-lifecycle"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 메인 윈도우 닫기 시: 플로팅 윈도우도 함께 닫힘

### R17: Settings 패널

**ASR:** none
**Input:** Settings Rail 클릭
**Behavior:**
1. 설정 항목: 셸 경로, 폰트 패밀리, 폰트 크기, 컬러 스킴
2. 변경 시 즉시 반영 (live preview)
3. 저장: main/settings에 IPC 요청 → 원자적 .tmp→rename
4. 기본값 폴백: 설정 파일 손상/누락 시 하드코딩 기본값 사용
5. 설정 파일 위치: `%APPDATA%/EZTerminal/settings.json`
**Output:** 설정 변경 및 저장
**Impact scope:**
- renderer/components: SettingsPanel
- renderer/stores: settingsSlice
- main/settings: SettingsService
**Acceptance criteria:**
- [ ] Given: Settings 패널
      When: 폰트 크기 변경
      Then: 모든 터미널에 즉시 반영
      Verify: `pnpm test -- --run --grep "settings-live-preview"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 설정 변경
      When: 저장
      Then: .tmp 파일 생성 후 rename으로 원자적 저장
      Verify: `pnpm test -- --run --grep "settings-atomic-save"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 설정 파일 손상
      When: 앱 시작
      Then: 기본값으로 폴백, 에러 로그
      Verify: `pnpm test -- --run --grep "settings-corrupt-fallback"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 셸 경로가 존재하지 않는 경로: 저장은 허용, PTY 생성 시 폴백

### R18: 앱 라이프사이클

**ASR:** ASR-5, ASR-6
**Input:** 앱 시작 / 종료
**Behavior:**
1. Startup: main 시작 → BrowserWindow 생성 → preload → renderer mount → 첫 PTY 생성 → ready
2. Shutdown (before-quit):
   a. 모든 PTY에 graceful termination 신호
   b. 5초 대기
   c. 미응답 PTY 개별 force kill
   d. settings 저장
   e. app.quit()
3. 셸 종료 이벤트 처리 (R10과 연동)
**Output:** 깔끔한 시작/종료
**Impact scope:**
- main/: 전체 라이프사이클 오케스트레이션
**Acceptance criteria:**
- [ ] Given: 앱 미실행
      When: 앱 시작
      Then: BrowserWindow + 첫 PTY 세션 생성, 셸 프롬프트 표시
      Verify: `pnpm test:e2e --grep "app-startup"`
      Verify-type: e2e
      Automatable: true
- [ ] Given: 앱 실행 중 (탭 3개)
      When: 창 닫기
      Then: 모든 PTY 정리 후 앱 종료, 5초 이내
      Verify: `pnpm test:e2e --grep "app-shutdown"`
      Verify-type: e2e
      Automatable: true
- [ ] Given: 앱 shutdown 중
      When: 한 PTY가 5초 내 미응답
      Then: 해당 PTY만 force kill, 나머지 정상 처리 후 종료
      Verify: `pnpm test -- --run --grep "shutdown-force-kill"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Shutdown 중 PTY 재시작 차단

### R19: Split indicator

**ASR:** none
**Input:** 탭의 LayoutNode 트리
**Behavior:**
1. 탭 라벨에 현재 분할 구조의 미니어처 렌더링
2. LeafNode: 작은 사각형
3. SplitNode: orientation에 따라 분할된 사각형
4. 비대칭 트리도 정확히 표현
5. null root (빈 탭): 빈 표시
**Output:** 탭에 분할 미니어처 표시
**Impact scope:**
- renderer/components: SplitIndicator
**Acceptance criteria:**
- [ ] Given: 단일 페인 탭
      When: 탭 라벨 렌더링
      Then: 단일 사각형 미니어처
      Verify: `pnpm test -- --run --grep "indicator-single"`
      Verify-type: lib
      Automatable: true
- [ ] Given: 2페인 horizontal 분할
      When: 탭 라벨 렌더링
      Then: 좌우 분할 미니어처
      Verify: `pnpm test -- --run --grep "indicator-split"`
      Verify-type: lib
      Automatable: true
- [ ] Given: null root
      When: 탭 라벨 렌더링
      Then: 빈 미니어처 (크래시 없음)
      Verify: `pnpm test -- --run --grep "indicator-null-safe"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- 4페인 비대칭 트리: 깊이 3 트리도 16x12px 영역에 정확히 렌더링
