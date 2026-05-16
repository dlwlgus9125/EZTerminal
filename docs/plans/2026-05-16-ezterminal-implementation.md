# EZTerminal Implementation Plan

**Goal:** Electron 기반 로컬 터미널 에뮬레이터 전체 구현 — xterm.js VT 렌더링, 다중 탭/분할, 시스템/네트워크 모니터링, 파일 탐색, 설정 관리.
**Architecture:** Electron 3-layer (main/preload/renderer) + Zustand 4-slice store. node-pty 1:1 pane 결합, 16ms frame coalescing, contextIsolation 보안 모델. Rail-based side panels with visibility lifecycle.
**ASR Summary:** Startup <3s (ASR-01), Key-to-PTY <16ms (ASR-02), Monitoring <100ms (ASR-03), Bundle <15MB (ASR-04), PTY 누수 0 (ASR-05), Npcap 없이 동작 (ASR-06), Settings 복구 (ASR-07), CWD scope 보안 (ASR-08), Renderer Node 차단 (ASR-09), 3-layer 위반 0 (ASR-10).
**Tech Stack:** Electron 36 + Forge 7, React 19, Zustand 5, xterm.js 5, node-pty 1.0, TypeScript 5.8, Vitest 3, Playwright, Biome, pnpm.
**Spec:** `docs/specs/2026-05-16-integrated-design.md`

---

## Context

EZTerminal은 scaffold 상태에서 시작한다. 7개 소스 파일(main/preload/renderer entry points + styles)만 존재하며, 모든 의존성은 설치 완료. 테스트 인프라(mock, helper, config)도 준비됨. 28개 요구사항(L1-L4), 108 AC를 12개 vertical-slice 태스크로 분해하여 구현한다.

현재 preload에 `unknown` 타입이 6곳 존재하고, `src/shared/` 디렉토리가 없으며, tsconfig에 shared 경로가 포함되지 않음. 모든 구현은 이 scaffold 위에 빌드된다.

---

## Coverage Matrix

| Requirement | ASR | Related Tasks |
|-------------|-----|---------------|
| R-L1-01: Shared IPC Type Definitions | ASR-09, ASR-10 | T1, T2 |
| R-L1-02: PTY Session Manager | ASR-05 | T1, T2 |
| R-L1-03: 16ms Frame Coalescing | ASR-02 | T1, T2 |
| R-L1-04: PTY IPC Handlers | ASR-02, ASR-09 | T1, T2 |
| R-L1-05: Preload Typed Bridge | ASR-09, ASR-10 | T1, T2 |
| R-L1-06: TerminalView Component | ASR-02 | T1, T2 |
| R-L1-07: Terminal I/O Wiring (E2E) | ASR-01, ASR-02 | T1 |
| R-L2-01: Zustand Store Architecture | ASR-10 | T3 |
| R-L2-02: Tab Management | ASR-05 | T3, T6 |
| R-L2-03: Pane Splitting | ASR-05 | T3, T6 |
| R-L2-04: SplitContainer Component | none | T4 |
| R-L2-05: TitleBar Component | none | T5 |
| R-L2-06: TabBar Component | none | T5 |
| R-L2-07: StatusBar Component | none | T5 |
| R-L2-08: Keyboard Shortcuts | none | T6 |
| R-L3-01: Rail Component | none | T7 |
| R-L3-02: useVisibilityLifecycle Hook | ASR-03 | T7 |
| R-L3-03: FilesPanel (CWD Explorer) | none | T10 |
| R-L3-04: File Preview (ezterm-file://) | ASR-08 | T10 |
| R-L3-05: StatusPanel (System Metrics) | ASR-03 | T8 |
| R-L3-06: NetworkPanel | ASR-06 | T9 |
| R-L3-07: SettingsPanel | ASR-07 | T10 |
| R-L3-08: Settings Persistence | ASR-07 | T10 |
| R-L4-01: Floating Panels | none | T11 |
| R-L4-02: Context Menu | none | T11 |
| R-L4-03: Command Palette | none | T11 |
| R-L4-04: Save Scrollback | none | T12 |
| R-L4-05: Find Bar | none | T12 |

Unmapped requirements: 0. All 28 requirements covered.

---

## Structural Invariants

| ID | Rule | Source | Verification |
|----|------|--------|--------------|
| SI-1 | Renderer는 main 모듈 직접 import 금지 | ASR-10, ADR-001 | `pnpm typecheck` (tsconfig boundary) |
| SI-2 | Preload ElectronAPI에 unknown 타입 0개 | ASR-09, AC-01-N1 | `grep -c "unknown" src/preload/index.ts \| test $(cat) -eq 0` |
| SI-3 | contextIsolation: true, nodeIntegration: false | ASR-09, ADR-001 | `grep "contextIsolation: true" src/main/index.ts && grep "nodeIntegration: false" src/main/index.ts` |
| SI-4 | TypeScript strict + noUncheckedIndexedAccess | ASR-10, conventions | `pnpm typecheck` |
| SI-5 | Biome 0 warnings | ASR-10 | `pnpm lint` |

---

## Task 1: Terminal I/O Skeleton [R-L1-07] {skeleton}

**ASR:** ASR-01, ASR-02
**Files:**
- Create: `src/shared/ipc-types.ts`, `src/shared/terminal-types.ts`, `src/main/pty-manager.ts`, `src/main/frame-buffer.ts`, `src/renderer/components/Terminal/TerminalView.tsx`, `src/renderer/components/Terminal/TerminalView.module.css`, `src/renderer/components/Terminal/index.ts`
- Modify: `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/App.tsx`, `tsconfig.main.json`, `tsconfig.preload.json`, `tsconfig.renderer.json`
- Test: `tests/unit/pty-manager.test.ts`, `tests/unit/frame-buffer.test.ts`, `tests/component/TerminalView.test.tsx`, `tests/e2e/terminal.e2e.ts`

**TDD Slice Contract:**
- Public interface: PtyManager.create(opts) -> IpcResult<string>, PtyManager.kill(id), FrameBuffer.push(id, data), FrameBuffer.onFlush(cb), ElectronAPI.pty.*, TerminalView component
- Behavior under test: 키 입력이 PTY stdin 도달, PTY stdout가 16ms 코알레싱 후 xterm 화면 표시
- Test oracle: e2e에서 "hello" 입력 시 xterm에 "hello" 표시, "echo test\n" 실행 시 "test" 출력 확인
- Required setup/fixtures: electron mock, node-pty mock, xterm mock (unit/component); 실제 Electron + PowerShell (e2e)
- Minimal implementation boundary: create/kill PTY만 구현, orphan scan 미구현; single session coalescing만; WebGL addon 미로드
- Non-goals: orphan 정리, per-session buffer 독립성, WebGL/Canvas fallback, Phosphor 테마 매핑, 키보드 단축키
- Missing-info handling: report NEEDS_CONTEXT/BLOCKED, do not guess

**Operational decisions:** Error handling: IpcResult<T> 패턴 | Logging: console.log only (logger 미구현) | Init order: app.whenReady → registerIpcHandlers → createWindow

**Depends on:** none
**File overlap with:** Task 2 (shared/, main/index.ts, preload/index.ts, TerminalView)

**Wiring handoff:**
- WM-EP-1: `main/index.ts` → app.whenReady entry point
- WM-EP-2: `renderer/main.tsx` → ReactDOM.createRoot
- WM-EP-3: `preload/index.ts` → contextBridge.exposeInMainWorld
- WM-REG-1: IPC handlers registered in `main/index.ts` (pty:create, pty:write, pty:resize, pty:kill, pty:data, pty:exit)
- WM-REG-2: PTY session Map in `main/pty-manager.ts`
- WM-REG-3: React component tree App → TerminalView
- WM-REG-5: xterm.js Terminal instance in `TerminalView`
- WM-REG-9: Frame coalescing buffer in `main/frame-buffer.ts`

**Completion criteria (from spec):**
- [x] Given: TerminalView + PTY 연결 / When: "hello" 입력 / Then: xterm에 "hello" 표시 / Verify: `pnpm test:e2e -- --grep "Terminal echo"`
- [x] Given: PowerShell PTY / When: "echo test\n" 입력 / Then: "test" 출력 표시 / Verify: `pnpm test:e2e -- --grep "Terminal command"`
- [x] Given: 앱 실행 / When: 완전 로드 / Then: 3초 이내 셸 프롬프트 / Verify: `pnpm test:e2e -- --grep "Terminal startup"`
- [x] Given: PTY 생성 실패 / When: IpcResult { ok: false } / Then: 에러 메시지 표시 / Verify: `pnpm test -- --grep "Terminal pty error"`

**Verification method:** Run e2e Verify commands after implementation.
**Runtime verification:** `pnpm test:e2e --grep smoke`
**Wiring probe:**
- Entry point: `src/main/index.ts` | Module: `src/main/pty-manager.ts` | Probe type: `runtime-load` | Verify: `pnpm test:e2e -- --grep "Terminal echo"`
- Entry point: `src/main/index.ts` | Module: `src/main/frame-buffer.ts` | Probe type: `runtime-load` | Verify: `pnpm test:e2e -- --grep "Terminal echo"`
- Entry point: `src/renderer/main.tsx` | Module: `src/renderer/components/Terminal/TerminalView.tsx` | Probe type: `e2e-touch` | Verify: `pnpm test:e2e -- --grep "Terminal echo"`

- [x] Step 1: Write e2e test for terminal echo (expect fail — no PTY).
- [x] Step 2: Create `src/shared/` types (IpcResult, PtyCreateOptions, PtySession).
- [x] Step 3: Update tsconfig files to include `src/shared/`.
- [x] Step 4: Implement PtyManager (create/kill + Map).
- [x] Step 5: Implement FrameBuffer (16ms coalescing).
- [x] Step 6: Register IPC handlers in `main/index.ts`.
- [x] Step 7: Update `preload/index.ts` PTY channels with shared types.
- [x] Step 8: Create TerminalView component (xterm mount + data wiring).
- [x] Step 9: Wire App.tsx to render TerminalView.
- [x] Step 10: Run e2e tests → pass.
- [x] Step 11: Run smoke → pass.
- [x] Step 12: Commit.

---

## Task 2: L1 Hardening [R-L1-01, R-L1-02, R-L1-03, R-L1-04, R-L1-05, R-L1-06] {feature}

**ASR:** ASR-02, ASR-05, ASR-09, ASR-10
**Files:**
- Create: `src/shared/metrics-types.ts`, `src/shared/network-types.ts`, `src/shared/settings-types.ts`
- Modify: `src/shared/ipc-types.ts`, `src/shared/terminal-types.ts`, `src/main/pty-manager.ts`, `src/main/frame-buffer.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/components/Terminal/TerminalView.tsx`
- Test: `tests/unit/pty-manager.test.ts`, `tests/unit/frame-buffer.test.ts`, `tests/unit/ipc-handlers.test.ts`, `tests/component/TerminalView.test.tsx`

**TDD Slice Contract:**
- Public interface: All shared types (IpcResult, PtyCreateOptions, MetricsData, TrafficData, ConnectionInfo, PacketData, UserSettings), PtyManager (orphan scan, error paths), FrameBuffer (per-session, cleanup), TerminalView (WebGL, fit, theme, unmount)
- Behavior under test: 타입 완전성, PTY orphan 정리, frame buffer 세션별 독립, WebGL/Canvas fallback
- Test oracle: typecheck 통과, PTY orphan Map 제거, 세션 종료 시 buffer 폐기, WebGL 실패 시 Canvas 정상 동작
- Required setup/fixtures: node-pty mock, xterm mock (WebGL fail simulation)
- Minimal implementation boundary: 모든 L1 AC 완료
- Non-goals: Zustand store, 탭/pane 관리, 키보드 단축키
- Missing-info handling: report NEEDS_CONTEXT/BLOCKED

**Impact scope:**
- (a) Reference breakage: `src/preload/index.ts` — unknown → 구체 타입 변경 시 ElectronAPI 소비자 영향
- (b) Call site info: `src/renderer/App.tsx` — TerminalView props 변경 가능
- (c) Code preservation: `src/main/index.ts` — 기존 IPC handler 등록 로직 보존

**Operational decisions:** Error handling: IpcResult<T> 전면 적용 | Logging: console.log (logger 미구현)
**Depends on:** Task 1
**File overlap with:** Task 1 (shared/, main/, preload/, TerminalView)
**Wiring handoff:**
- WM-C-1: IpcResult<T> 에러 전파 패턴 확립 — 이후 모든 IPC handler가 참조
- WM-C-2: PTY cleanup (before-quit + 30s orphan scan) 구현
- WM-C-5: WebGL context (active-only + dispose/recreate) 구현

**Completion criteria (from spec):**
- [x] AC-01-1: IpcResult<T> 타입 정의 / Verify: `pnpm typecheck`
- [x] AC-01-2: PTY 채널 타입 / Verify: `pnpm typecheck`
- [x] AC-01-3: Metrics 타입 / Verify: `pnpm typecheck`
- [x] AC-01-4: Network 타입 / Verify: `pnpm typecheck`
- [x] AC-01-5: Settings 타입 / Verify: `pnpm typecheck`
- [x] AC-01-N1: preload unknown 0개 / Verify: `grep -c "unknown" src/preload/index.ts | test $(cat) -eq 0`
- [x] AC-02-1: PTY create → UUID + Map / Verify: `pnpm test -- --grep "PtyManager create"`
- [x] AC-02-2: PTY kill → 종료 + Map 제거 / Verify: `pnpm test -- --grep "PtyManager kill"`
- [x] AC-02-3: before-quit 전체 정리 / Verify: `pnpm test -- --grep "PtyManager cleanup"`
- [x] AC-02-4: Orphan 30초 스캔 / Verify: `pnpm test -- --grep "PtyManager orphan"`
- [x] AC-02-N1: 잘못된 shell → PTY_CREATE_FAILED / Verify: `pnpm test -- --grep "PtyManager invalid shell"`
- [x] AC-02-N2: 없는 세션 kill → SESSION_NOT_FOUND / Verify: `pnpm test -- --grep "PtyManager kill nonexistent"`
- [x] AC-03-1: 16ms 내 여러 청크 합침 / Verify: `pnpm test -- --grep "FrameBuffer coalesce"`
- [x] AC-03-2: 첫 청크 시 타이머 시작 / Verify: `pnpm test -- --grep "FrameBuffer flush"`
- [x] AC-03-3: 세션별 독립 버퍼 / Verify: `pnpm test -- --grep "FrameBuffer per-session"`
- [x] AC-03-N1: 세션 종료 시 버퍼 폐기 / Verify: `pnpm test -- --grep "FrameBuffer cleanup"`
- [x] AC-04-1: pty:create → IpcResult<string> / Verify: `pnpm test -- --grep "IPC pty:create"`
- [x] AC-04-2: pty:write → stdin 기록 / Verify: `pnpm test -- --grep "IPC pty:write"`
- [x] AC-04-3: pty:resize → PTY resize / Verify: `pnpm test -- --grep "IPC pty:resize"`
- [x] AC-04-4: pty:data push / Verify: `pnpm test -- --grep "IPC pty:data push"`
- [x] AC-04-N1: 없는 세션 write 무시 / Verify: `pnpm test -- --grep "IPC pty:write nonexistent"`
- [x] AC-05-1: pty.create → Promise<IpcResult<string>> / Verify: `pnpm typecheck`
- [x] AC-05-2: metrics.onUpdate → (data: MetricsData) => void / Verify: `pnpm typecheck`
- [x] AC-05-3: settings.load → Promise<IpcResult<UserSettings>> / Verify: `pnpm typecheck`
- [x] AC-05-N1: 타입 불일치 시 컴파일 에러 / Verify: `pnpm typecheck`
- [x] AC-06-1: xterm.js 마운트 / Verify: `pnpm test -- --grep "TerminalView mount"`
- [x] AC-06-2: WebGL addon 로딩 / Verify: `pnpm test -- --grep "TerminalView webgl"`
- [x] AC-06-3: addon-fit / Verify: `pnpm test -- --grep "TerminalView fit"`
- [x] AC-06-4: Phosphor 테마 / Verify: `pnpm test -- --grep "TerminalView theme"`
- [x] AC-06-5: 언마운트 정리 / Verify: `pnpm test -- --grep "TerminalView unmount"`
- [x] AC-06-N1: WebGL 실패 Canvas fallback / Verify: `pnpm test -- --grep "TerminalView canvas fallback"`
- [x] AC-06-N2: 0 크기 컨테이너 / Verify: `pnpm test -- --grep "TerminalView zero size"`

**Verification method:** Run all listed Verify commands.
**Runtime verification:** `pnpm test:e2e --grep smoke`
**Wiring probe:**
- Entry point: `src/main/index.ts` | Module: `src/shared/metrics-types.ts` | Probe type: `import-chain` | Verify: `pnpm typecheck`
- Entry point: `src/main/index.ts` | Module: `src/shared/network-types.ts` | Probe type: `import-chain` | Verify: `pnpm typecheck`
- Entry point: `src/main/index.ts` | Module: `src/shared/settings-types.ts` | Probe type: `import-chain` | Verify: `pnpm typecheck`

- [x] Step 1: Create remaining shared types (metrics, network, settings).
- [x] Step 2: Update preload — replace all unknown with concrete types.
- [x] Step 3: Run typecheck → pass.
- [x] Step 4: Write PTY lifecycle tests (orphan, error paths).
- [x] Step 5: Implement PTY orphan scan + error handling.
- [x] Step 6: Write frame buffer tests (per-session, cleanup).
- [x] Step 7: Complete frame buffer implementation.
- [x] Step 8: Write IPC handler tests (all channels).
- [x] Step 9: Complete IPC handler coverage.
- [x] Step 10: Write TerminalView tests (WebGL, fit, theme, unmount, fallbacks).
- [x] Step 11: Complete TerminalView (WebGL addon, FitAddon, theme, unmount, Canvas fallback).
- [x] Step 12: Run all Verify commands → pass.
- [x] Step 13: Commit.

---

## Task 3: Zustand Store + Tab/Pane Logic [R-L2-01, R-L2-02, R-L2-03] {feature}

**ASR:** ASR-05, ASR-10
**Files:**
- Create: `src/renderer/store/index.ts`, `src/renderer/store/terminal-slice.ts`, `src/renderer/store/layout-slice.ts`, `src/renderer/store/panel-slice.ts` (stub), `src/renderer/store/settings-slice.ts` (stub)
- Test: `tests/unit/terminal-slice.test.ts`, `tests/unit/layout-slice.test.ts`, `tests/unit/store-cross-slice.test.ts`

**TDD Slice Contract:**
- Public interface: useStore hook, terminalSlice (sessions, activeSessionId), layoutSlice (tabs, activeTabId, LayoutNode, addTab, closeTab, splitPane, closePane, focusPane)
- Behavior under test: 탭 생성/닫기/전환, pane 분할/닫기/포커스, 마지막 탭/pane 닫기 차단, cross-slice closeTab → PTY kill
- Test oracle: store state 검증, closeTab 시 PTY kill 호출 확인, 마지막 탭 closeTab → state 불변
- Required setup/fixtures: store test helper (createIsolatedStore)
- Minimal implementation boundary: 4 slice create, tab/pane CRUD, cross-slice coordination
- Non-goals: SplitContainer 렌더링, UI 컴포넌트, 키보드 단축키
- Missing-info handling: report NEEDS_CONTEXT/BLOCKED

**Operational decisions:** none applicable
**Depends on:** Task 2 (shared types for terminal session)
**File overlap with:** Task 4 (App.tsx에서 store 소비), Task 5 (TabBar store 소비)
**Wiring handoff:**
- WM-REG-4: Zustand store slices registered in `store/index.ts`
- WM-C-6: Cross-slice coordination via get() in actions

**Completion criteria (from spec):**
- [ ] AC-L2-01-1: 4 slice store 생성 / Verify: `pnpm test -- --grep "Store creation"`
- [ ] AC-L2-01-2: terminalSlice / Verify: `pnpm test -- --grep "terminalSlice"`
- [ ] AC-L2-01-3: layoutSlice / Verify: `pnpm test -- --grep "layoutSlice"`
- [ ] AC-L2-01-4: Cross-slice closeTab / Verify: `pnpm test -- --grep "cross-slice closeTab"`
- [ ] AC-L2-01-N1: 마지막 탭 닫기 차단 / Verify: `pnpm test -- --grep "closeTab last tab"`
- [ ] AC-L2-02-1 through AC-L2-02-N1: Tab create/close/switch/last-block (e2e deferred to T6)
- [ ] AC-L2-03-1 through AC-L2-03-N2: Pane split/close/focus/max/last-block (e2e deferred to T6)

**Verification method:** Unit test Verify commands.
**Wiring probe:**
- Entry point: `src/renderer/main.tsx` | Module: `src/renderer/store/index.ts` | Probe type: `import-chain` | Verify: `pnpm typecheck`

- [ ] Step 1: Write terminalSlice tests.
- [ ] Step 2: Implement terminalSlice.
- [ ] Step 3: Write layoutSlice tests (tab + pane operations).
- [ ] Step 4: Implement layoutSlice (LayoutNode binary tree).
- [ ] Step 5: Write cross-slice test (closeTab → PTY kill).
- [ ] Step 6: Implement cross-slice coordination.
- [ ] Step 7: Create panel-slice + settings-slice stubs.
- [ ] Step 8: Create store/index.ts (combine slices).
- [ ] Step 9: Run Verify commands → pass.
- [ ] Step 10: Commit.

---

## Task 4: SplitContainer [R-L2-04] {feature}

**ASR:** none
**Files:**
- Create: `src/renderer/components/SplitContainer/SplitContainer.tsx`, `src/renderer/components/SplitContainer/SplitContainer.module.css`, `src/renderer/components/SplitContainer/index.ts`
- Modify: `src/renderer/App.tsx`
- Test: `tests/component/SplitContainer.test.tsx`, `tests/component/SplitContainer.wiring.test.tsx`

**TDD Slice Contract:**
- Public interface: SplitContainer component (props: LayoutNode, renderLeaf callback)
- Behavior under test: LayoutNode tree → CSS Grid 렌더링, 6px 거터 드래그 비율 조정, 더블클릭 50:50 리셋
- Test oracle: DOM 구조 검증 (grid-template-columns/rows), 드래그 후 비율 변경, 리셋 후 50:50
- Required setup/fixtures: @testing-library/react, user-event, jsdom
- Minimal implementation boundary: 재귀 렌더링, 거터 드래그, 리셋, invalid node fallback
- Non-goals: 키보드 접근성, 최소 pane 크기 제한

**Impact scope:**
- (a) Reference breakage: `src/renderer/App.tsx` — 기존 단일 TerminalView를 SplitContainer로 교체
- (c) Code preservation: `src/renderer/App.tsx` — React StrictMode, data-theme 설정 보존

**Operational decisions:** none applicable
**Depends on:** Task 3 (LayoutNode type from layoutSlice)
**File overlap with:** Task 5 (App.tsx)

**Completion criteria (from spec):**
- [ ] AC-L2-04-1: CSS Grid 수평 2 pane / Verify: `pnpm test -- --grep "SplitContainer render"`
- [ ] AC-L2-04-2: 6px 거터 드래그 비율 조정 / Verify: `pnpm test -- --grep "SplitContainer gutter drag"`
- [ ] AC-L2-04-3: 더블클릭 50:50 리셋 / Verify: `pnpm test -- --grep "SplitContainer reset"`
- [ ] AC-L2-04-N1: 잘못된 LayoutNode fallback / Verify: `pnpm test -- --grep "SplitContainer invalid node"`

**Verification method:** Component test Verify commands.
**View wiring verification:** `tests/component/SplitContainer.wiring.test.tsx` — W1 binding (LayoutNode → grid), W2 handler (gutter drag → ratio update), W5 template (split vs leaf rendering)
**Wiring probe:**
- Entry point: `src/renderer/main.tsx` | Module: `src/renderer/components/SplitContainer/SplitContainer.tsx` | Probe type: `import-chain` | Verify: `pnpm typecheck`

- [ ] Step 1-6: TDD red-green for SplitContainer.
- [ ] Step 7: Wire into App.tsx.
- [ ] Step 8: Run Verify + wiring tests → pass.
- [ ] Step 9: Commit.

---

## Task 5: UI Chrome — TitleBar, TabBar, StatusBar [R-L2-05, R-L2-06, R-L2-07] {feature}

**ASR:** none
**Files:**
- Create: `src/renderer/components/TitleBar/TitleBar.tsx`, `TitleBar.module.css`, `index.ts`, `src/renderer/components/TabBar/TabBar.tsx`, `TabBar.module.css`, `index.ts`, `src/renderer/components/StatusBar/StatusBar.tsx`, `StatusBar.module.css`, `index.ts`
- Modify: `src/renderer/App.tsx`
- Test: `tests/component/TitleBar.test.tsx`, `tests/component/TabBar.test.tsx`, `tests/component/StatusBar.test.tsx`, 각 `*.wiring.test.tsx`

**TDD Slice Contract:**
- Public interface: TitleBar (drag region + 3 window controls), TabBar (tab list + add button + active indicator), StatusBar (shell name + cols/rows + encoding)
- Behavior under test: TitleBar 드래그/min/max/close IPC, TabBar 탭 목록/추가 버튼, StatusBar 정보 표시
- Test oracle: DOM 속성 검증 (-webkit-app-region: drag), IPC 호출 mock 검증, 렌더링 텍스트 검증
- Required setup/fixtures: electron mock (window IPC), store mock
- Minimal implementation boundary: 3 컴포넌트 구현, App.tsx 레이아웃 조립
- Non-goals: 탭 드래그 재배열, 탭 오버플로우 스크롤

**Operational decisions:** none applicable
**Depends on:** Task 3 (store for tab list, terminal info)
**File overlap with:** Task 4 (App.tsx), Task 7 (App.tsx)

**Completion criteria (from spec):**
- [ ] AC-L2-05-1: 윈도우 드래그 / Verify: `pnpm test -- --grep "TitleBar drag"`
- [ ] AC-L2-05-2: 윈도우 컨트롤 / Verify: `pnpm test -- --grep "TitleBar controls"`
- [ ] AC-L2-06-1: 탭 목록 렌더링 / Verify: `pnpm test -- --grep "TabBar render"`
- [ ] AC-L2-06-2: 새 탭 버튼 / Verify: `pnpm test -- --grep "TabBar add"`
- [ ] AC-L2-07-1: 상태 표시 / Verify: `pnpm test -- --grep "StatusBar display"`

**Verification method:** Component test Verify commands.
**View wiring verification:** `tests/component/TitleBar.wiring.test.tsx`, `TabBar.wiring.test.tsx`, `StatusBar.wiring.test.tsx`
**Wiring probe:**
- Entry point: `src/renderer/main.tsx` | Module: `src/renderer/components/TitleBar/TitleBar.tsx` | Probe type: `import-chain` | Verify: `pnpm typecheck`
- Entry point: `src/renderer/main.tsx` | Module: `src/renderer/components/TabBar/TabBar.tsx` | Probe type: `import-chain` | Verify: `pnpm typecheck`

- [ ] Step 1-6: TDD red-green for each component.
- [ ] Step 7: Assemble in App.tsx layout.
- [ ] Step 8: Run Verify + wiring tests → pass.
- [ ] Step 9: Commit.

---

## Task 6: Keyboard Shortcuts [R-L2-08, R-L2-02 e2e, R-L2-03 e2e] {feature}

**ASR:** ASR-05
**Files:**
- Create: `src/renderer/hooks/useKeyboardShortcuts.ts`
- Modify: `src/renderer/App.tsx`, `src/renderer/components/Terminal/TerminalView.tsx`
- Test: `tests/e2e/keyboard.e2e.ts`, `tests/e2e/tabs.e2e.ts`, `tests/e2e/panes.e2e.ts`

**TDD Slice Contract:**
- Public interface: useKeyboardShortcuts hook, TerminalView attachCustomKeyEventHandler
- Behavior under test: Ctrl+T/W/Tab → 탭 생성/닫기/전환, Ctrl+Shift+D/E/W → pane 분할/닫기, Ctrl+Alt+Arrow → pane 포커스, Ctrl+C → SIGINT (not Copy), 일반 키 → PTY 전달
- Test oracle: e2e에서 키 입력 후 탭/pane 생성/닫기/포커스 확인, Ctrl+C 시 SIGINT 전달 확인
- Required setup/fixtures: Playwright Electron, 실제 앱 빌드
- Minimal implementation boundary: 모든 단축키 바인딩, customKeyEventHandler
- Non-goals: 사용자 정의 단축키 설정

**Impact scope:**
- (b) Call site info: `src/renderer/components/Terminal/TerminalView.tsx` — attachCustomKeyEventHandler 추가
- (c) Code preservation: `src/renderer/App.tsx` — 기존 layout 구조 보존

**Operational decisions:** none applicable
**Depends on:** Task 4 (SplitContainer), Task 5 (UI Chrome)
**File overlap with:** Task 11 (useKeyboardShortcuts — Ctrl+Shift+P 추가), Task 12 (useKeyboardShortcuts — Ctrl+F 추가)

**Completion criteria (from spec):**
- [ ] AC-L2-08-1: 글로벌 Ctrl+T/W/Tab / Verify: `pnpm test:e2e -- --grep "Keyboard global"`
- [ ] AC-L2-08-2: 터미널 Ctrl+Shift+D / Verify: `pnpm test:e2e -- --grep "Keyboard terminal"`
- [ ] AC-L2-08-3: PTY passthrough / Verify: `pnpm test:e2e -- --grep "Keyboard passthrough"`
- [ ] AC-L2-08-N1: Ctrl+C → SIGINT / Verify: `pnpm test:e2e -- --grep "Keyboard ctrl-c sigint"`
- [ ] AC-L2-02-1: 새 탭 Ctrl+T / Verify: `pnpm test:e2e -- --grep "Tab create"`
- [ ] AC-L2-02-2: 탭 닫기 Ctrl+W / Verify: `pnpm test:e2e -- --grep "Tab close"`
- [ ] AC-L2-02-3: 탭 전환 Ctrl+Tab / Verify: `pnpm test:e2e -- --grep "Tab switch"`
- [ ] AC-L2-02-N1: 마지막 탭 Ctrl+W 차단 / Verify: `pnpm test:e2e -- --grep "Tab close last blocked"`
- [ ] AC-L2-03-1: 우측 분할 Ctrl+Shift+D / Verify: `pnpm test:e2e -- --grep "Pane split right"`
- [ ] AC-L2-03-2: 하단 분할 Ctrl+Shift+E / Verify: `pnpm test:e2e -- --grep "Pane split down"`
- [ ] AC-L2-03-3: Pane 닫기 Ctrl+Shift+W / Verify: `pnpm test:e2e -- --grep "Pane close"`
- [ ] AC-L2-03-4: Pane 포커스 Ctrl+Alt+Arrow / Verify: `pnpm test:e2e -- --grep "Pane focus"`
- [ ] AC-L2-03-N1: 4 pane 초과 차단 / Verify: `pnpm test:e2e -- --grep "Pane split max"`
- [ ] AC-L2-03-N2: 마지막 pane 닫기 차단 / Verify: `pnpm test:e2e -- --grep "Pane close last blocked"`

**Verification method:** e2e Verify commands.
**Runtime verification:** `pnpm test:e2e --grep smoke`
**Wiring probe:**
- Entry point: `src/renderer/main.tsx` | Module: `src/renderer/hooks/useKeyboardShortcuts.ts` | Probe type: `import-chain` | Verify: `pnpm typecheck`

- [ ] Step 1: Write e2e tests for keyboard shortcuts.
- [ ] Step 2: Implement useKeyboardShortcuts hook.
- [ ] Step 3: Wire customKeyEventHandler in TerminalView.
- [ ] Step 4: Mount hook in App.tsx.
- [ ] Step 5: Write e2e tests for tab/pane operations.
- [ ] Step 6: Run all e2e Verify commands → pass.
- [ ] Step 7: Commit.

---

## Task 7: Rail + Visibility Lifecycle [R-L3-01, R-L3-02] {feature}

**ASR:** ASR-03
**Files:**
- Create: `src/renderer/components/Rail/Rail.tsx`, `Rail.module.css`, `index.ts`, `src/renderer/hooks/useVisibilityLifecycle.ts`
- Modify: `src/renderer/App.tsx`, `src/renderer/store/panel-slice.ts`, `src/renderer/styles/global.css`
- Test: `tests/component/Rail.test.tsx`, `tests/component/Rail.wiring.test.tsx`, `tests/component/useVisibilityLifecycle.test.tsx`

**TDD Slice Contract:**
- Public interface: Rail (4 icons, active indicator, panel toggle), useVisibilityLifecycle(options: {start, stop, deps})
- Behavior under test: Rail 클릭 → 300px 패널 열림/닫힘, 패널 전환 시 이전 collector 중지, 윈도우 최소화 → collector 중지, 빠른 토글 중복 방지
- Test oracle: panelSlice state 검증, start/stop 콜백 호출 횟수 검증
- Required setup/fixtures: store mock, document.visibilityState mock
- Minimal implementation boundary: Rail 4 아이콘, 패널 토글, useVisibilityLifecycle
- Non-goals: 패널 내용 컴포넌트 (T8-T10에서 구현)

**Impact scope:**
- (a) Reference breakage: `src/renderer/App.tsx` — layout 구조에 Rail + panel area 추가
- (c) Code preservation: `src/renderer/store/panel-slice.ts` — stub을 완전 구현으로 교체

**Operational decisions:** none applicable
**Depends on:** Task 6 (L2 layout 완성 후)
**File overlap with:** Task 8, T9, T10 (panel 컴포넌트가 Rail 영역에 렌더링)
**Wiring handoff:**
- WM-REG-6: Visibility lifecycle hook → panels 마운트 시 소비
- WM-C-3: Collector lifecycle 패턴 확립

**Completion criteria (from spec):**
- [ ] AC-L3-01-1: 4 아이콘 48px / Verify: `pnpm test -- --grep "Rail render"`
- [ ] AC-L3-01-2: 패널 열기 300px / Verify: `pnpm test -- --grep "Rail toggle open"`
- [ ] AC-L3-01-3: 패널 닫기 / Verify: `pnpm test -- --grep "Rail toggle close"`
- [ ] AC-L3-01-N1: 패널 전환 시 이전 정리 / Verify: `pnpm test -- --grep "Rail switch panel"`
- [ ] AC-L3-02-1: 열기 → start / Verify: `pnpm test -- --grep "visibility start"`
- [ ] AC-L3-02-2: 닫기 → stop / Verify: `pnpm test -- --grep "visibility stop"`
- [ ] AC-L3-02-3: 최소화 → stop / Verify: `pnpm test -- --grep "visibility minimize"`
- [ ] AC-L3-02-N1: 빠른 토글 중복 방지 / Verify: `pnpm test -- --grep "visibility rapid toggle"`

**Verification method:** Component test Verify commands.
**View wiring verification:** `tests/component/Rail.wiring.test.tsx` — W1 binding (panelSlice → active icon), W2 handler (click → toggle action)
**Wiring probe:**
- Entry point: `src/renderer/main.tsx` | Module: `src/renderer/components/Rail/Rail.tsx` | Probe type: `import-chain` | Verify: `pnpm typecheck`
- Entry point: `src/renderer/main.tsx` | Module: `src/renderer/hooks/useVisibilityLifecycle.ts` | Probe type: `import-chain` | Verify: `pnpm typecheck`

- [ ] Step 1-8: TDD red-green for Rail + useVisibilityLifecycle.
- [ ] Step 9: Complete panel-slice implementation.
- [ ] Step 10: Update App.tsx layout (Rail + panel area).
- [ ] Step 11: Run Verify commands → pass.
- [ ] Step 12: Commit.

---

## Task 8: StatusPanel + Metrics [R-L3-05] {feature}

**ASR:** ASR-03
**Files:**
- Create: `src/main/metrics.ts`, `src/renderer/components/panels/StatusPanel/StatusPanel.tsx`, `StatusPanel.module.css`, `index.ts`
- Modify: `src/main/index.ts`, `src/renderer/components/Rail/Rail.tsx` (or panel registry)
- Test: `tests/unit/metrics.test.ts`, `tests/component/StatusPanel.test.tsx`, `tests/component/StatusPanel.wiring.test.tsx`

**TDD Slice Contract:**
- Public interface: MetricsCollector (start/stop/poll), StatusPanel (CPU/mem/disk/GPU display)
- Behavior under test: 2초 폴링 → CPU/mem/disk 수집, IPC push → StatusPanel 렌더, SI 에러 → 로그 + 재시도
- Test oracle: MetricsData 구조 검증, 패널 렌더링 텍스트 검증
- Required setup/fixtures: systeminformation mock
- Minimal implementation boundary: collector + push + panel render + error resilience
- Non-goals: 차트/그래프 시각화, 히스토리 저장

**Operational decisions:** Logging: console.log for SI errors
**Depends on:** Task 7 (Rail + useVisibilityLifecycle)
**File overlap with:** Task 9, T10 (main/index.ts handler registration)
**Wiring handoff:** WM-DF-4: metrics:start → SI poll → metrics:update → StatusPanel

**Completion criteria (from spec):**
- [ ] AC-L3-05-1: 2초 폴링 / Verify: `pnpm test -- --grep "Metrics collector"`
- [ ] AC-L3-05-2: metrics:update push / Verify: `pnpm test -- --grep "Metrics push"`
- [ ] AC-L3-05-3: CPU/mem/disk 렌더링 / Verify: `pnpm test -- --grep "StatusPanel render"`
- [ ] AC-L3-05-N1: SI 에러 resilience / Verify: `pnpm test -- --grep "Metrics error resilience"`

**Verification method:** Unit + component test Verify commands.
**View wiring verification:** `tests/component/StatusPanel.wiring.test.tsx`
**Wiring probe:**
- Entry point: `src/main/index.ts` | Module: `src/main/metrics.ts` | Probe type: `runtime-load` | Verify: `pnpm test -- --grep "Metrics collector"`

- [ ] Step 1-6: TDD red-green for MetricsCollector + StatusPanel.
- [ ] Step 7: Register handlers in main/index.ts.
- [ ] Step 8: Run Verify commands → pass.
- [ ] Step 9: Commit.

---

## Task 9: NetworkPanel [R-L3-06] {feature}

**ASR:** ASR-06
**Files:**
- Create: `src/main/network.ts`, `src/renderer/components/panels/NetworkPanel/NetworkPanel.tsx`, `NetworkPanel.module.css`, `index.ts`
- Modify: `src/main/index.ts`
- Test: `tests/unit/network.test.ts`, `tests/component/NetworkPanel.test.tsx`, `tests/component/NetworkPanel.wiring.test.tsx`

**TDD Slice Contract:**
- Public interface: NetworkCollector (start/stop, npcapAvailable flag), NetworkPanel (traffic stats, connections, capture, Npcap fallback UI)
- Behavior under test: Npcap 감지, networkStats fallback, 연결 테이블, 패킷 캡처, Npcap 미설치 UI
- Test oracle: npcapAvailable 플래그 검증, fallback 데이터 수집 확인, UI "Npcap required" 텍스트 검증
- Required setup/fixtures: cap mock, systeminformation mock
- Minimal implementation boundary: Npcap detect + traffic + connections + capture + fallback UI
- Non-goals: 패킷 분석/파싱, 프로토콜 디코딩

**Operational decisions:** Error handling: Npcap 없을 시 graceful degradation (ADR-007)
**Depends on:** Task 7 (Rail + useVisibilityLifecycle)
**File overlap with:** Task 8, T10 (main/index.ts)
**Wiring handoff:** WM-DF-5: network:start → cap/SI → network:traffic → NetworkPanel

**Completion criteria (from spec):**
- [ ] AC-L3-06-1: Npcap 감지 / Verify: `pnpm test -- --grep "Network npcap detect"`
- [ ] AC-L3-06-2: 트래픽 통계 / Verify: `pnpm test -- --grep "Network traffic stats"`
- [ ] AC-L3-06-3: 연결 테이블 / Verify: `pnpm test -- --grep "Network connections"`
- [ ] AC-L3-06-4: 패킷 캡처 / Verify: `pnpm test -- --grep "Network capture"`
- [ ] AC-L3-06-5: Npcap 미설치 UI / Verify: `pnpm test -- --grep "Network npcap fallback UI"`
- [ ] AC-L3-06-N1: 인터페이스 없음 / Verify: `pnpm test -- --grep "Network no interface"`

**Verification method:** Unit + component test Verify commands.
**View wiring verification:** `tests/component/NetworkPanel.wiring.test.tsx`
**Wiring probe:**
- Entry point: `src/main/index.ts` | Module: `src/main/network.ts` | Probe type: `runtime-load` | Verify: `pnpm test -- --grep "Network npcap detect"`

- [ ] Step 1-8: TDD red-green for NetworkCollector + NetworkPanel.
- [ ] Step 9: Register handlers in main/index.ts.
- [ ] Step 10: Run Verify commands → pass.
- [ ] Step 11: Commit.

---

## Task 10: Files + Preview + Settings [R-L3-03, R-L3-04, R-L3-07, R-L3-08] {feature}

**ASR:** ASR-07, ASR-08
**Files:**
- Create: `src/main/filesystem.ts`, `src/main/file-protocol.ts`, `src/main/settings.ts`, `src/renderer/components/panels/FilesPanel/FilesPanel.tsx`, `FilesPanel.module.css`, `index.ts`, `src/renderer/components/panels/SettingsPanel/SettingsPanel.tsx`, `SettingsPanel.module.css`, `index.ts`
- Modify: `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/store/settings-slice.ts`
- Test: `tests/unit/filesystem.test.ts`, `tests/unit/file-protocol.test.ts`, `tests/unit/settings.test.ts`, `tests/component/FilesPanel.test.tsx`, `tests/component/SettingsPanel.test.tsx`, `tests/component/FilesPanel.wiring.test.tsx`, `tests/component/SettingsPanel.wiring.test.tsx`

**TDD Slice Contract:**
- Public interface: FilesystemManager (readDir, watch), FileProtocolHandler (validate, serve), SettingsManager (load, save, defaults, corrupt recovery), FilesPanel (file tree, virtual scroll), SettingsPanel (form, save, apply)
- Behavior under test: CWD 감지(OSC7+fallback), 파일 트리 가상화, path traversal 차단, 확장자 whitelist, 10MB 제한, atomic write, 손상 복구, 즉시 반영
- Test oracle: 파일 리스트 검증, 거부 응답 검증, atomic write 파일 존재 확인, corrupt → 기본값 복구 확인
- Required setup/fixtures: chokidar mock, fs mock, store mock
- Minimal implementation boundary: 모든 L3-03, L3-04, L3-07, L3-08 AC
- Non-goals: 파일 편집, 파일 삭제, 테마 편집기

**Impact scope:**
- (a) Reference breakage: `src/preload/index.ts` — filesystem/settings 채널 추가
- (c) Code preservation: `src/main/index.ts` — 기존 IPC handler 보존

**Operational decisions:** Error handling: IpcResult<T> | Config: settings.json atomic write with .tmp → rename | Logging: electron-log (settings tag)
**Depends on:** Task 7 (Rail + useVisibilityLifecycle)
**File overlap with:** Task 8, T9 (main/index.ts)
**Wiring handoff:**
- WM-REG-7: ezterm-file:// protocol registered in main
- WM-REG-8: chokidar watcher in filesystem.ts
- WM-DF-3: settings:load → file → renderer
- WM-DF-6: OSC 7 CWD → chokidar → IPC → file tree
- WM-DF-8: click → ezterm-file:// → preview
- WM-DF-9: save → main write → broadcast

**Completion criteria (from spec):**
- [ ] AC-L3-03-1: CWD OSC 7 / Verify: `pnpm test -- --grep "FilesPanel CWD OSC7"`
- [ ] AC-L3-03-2: Win32 CWD fallback / Verify: `pnpm test -- --grep "FilesPanel CWD fallback"`
- [ ] AC-L3-03-3: 파일 트리 + 가상 스크롤 / Verify: `pnpm test -- --grep "FilesPanel tree"`
- [ ] AC-L3-03-4: 실시간 감지 / Verify: `pnpm test -- --grep "FilesPanel watch"`
- [ ] AC-L3-03-N1: 접근 불가 / Verify: `pnpm test -- --grep "FilesPanel access denied"`
- [ ] AC-L3-04-1: 텍스트 미리보기 / Verify: `pnpm test -- --grep "Preview text"`
- [ ] AC-L3-04-2: 이미지 미리보기 / Verify: `pnpm test -- --grep "Preview image"`
- [ ] AC-L3-04-3: Path traversal 차단 / Verify: `pnpm test -- --grep "Protocol traversal"`
- [ ] AC-L3-04-N1: 비허용 확장자 / Verify: `pnpm test -- --grep "Protocol extension blocked"`
- [ ] AC-L3-04-N2: 10MB 초과 / Verify: `pnpm test -- --grep "Preview size limit"`
- [ ] AC-L3-07-1: 설정 로드 / Verify: `pnpm test -- --grep "Settings load"`
- [ ] AC-L3-07-2: 설정 저장 / Verify: `pnpm test -- --grep "Settings save"`
- [ ] AC-L3-07-3: 즉시 반영 / Verify: `pnpm test -- --grep "Settings apply"`
- [ ] AC-L3-07-N1: 잘못된 값 거부 / Verify: `pnpm test -- --grep "Settings validation"`
- [ ] AC-L3-08-1: 파일 읽기 / Verify: `pnpm test -- --grep "Settings file load"`
- [ ] AC-L3-08-2: Atomic 쓰기 / Verify: `pnpm test -- --grep "Settings atomic write"`
- [ ] AC-L3-08-3: 기본값 생성 / Verify: `pnpm test -- --grep "Settings default"`
- [ ] AC-L3-08-N1: 손상 JSON 복구 / Verify: `pnpm test -- --grep "Settings corrupt"`

**Verification method:** Unit + component test Verify commands.
**View wiring verification:** `tests/component/FilesPanel.wiring.test.tsx`, `tests/component/SettingsPanel.wiring.test.tsx`
**Wiring probe:**
- Entry point: `src/main/index.ts` | Module: `src/main/filesystem.ts` | Probe type: `runtime-load` | Verify: `pnpm test -- --grep "FilesPanel CWD OSC7"`
- Entry point: `src/main/index.ts` | Module: `src/main/file-protocol.ts` | Probe type: `runtime-load` | Verify: `pnpm test -- --grep "Protocol traversal"`
- Entry point: `src/main/index.ts` | Module: `src/main/settings.ts` | Probe type: `runtime-load` | Verify: `pnpm test -- --grep "Settings file load"`

- [ ] Step 1-4: TDD for filesystem + file-protocol (main side).
- [ ] Step 5-6: TDD for settings persistence (main side).
- [ ] Step 7-8: TDD for FilesPanel + preview (renderer side).
- [ ] Step 9-10: TDD for SettingsPanel (renderer side).
- [ ] Step 11: Update preload with new channels.
- [ ] Step 12: Register all handlers in main/index.ts.
- [ ] Step 13: Complete settings-slice implementation.
- [ ] Step 14: Run all Verify commands → pass.
- [ ] Step 15: Commit.

---

## Task 11: Floating Panels + Context Menu + Command Palette [R-L4-01, R-L4-02, R-L4-03] {feature}

**ASR:** none
**Files:**
- Create: `src/renderer/components/FloatingPanel/FloatingPanel.tsx`, `index.ts`, `src/renderer/components/ContextMenu/ContextMenu.tsx`, `ContextMenu.module.css`, `index.ts`, `src/renderer/components/CommandPalette/CommandPalette.tsx`, `CommandPalette.module.css`, `index.ts`
- Modify: `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/App.tsx`, `src/renderer/hooks/useKeyboardShortcuts.ts`
- Test: `tests/e2e/floating.e2e.ts`, `tests/component/ContextMenu.test.tsx`, `tests/component/CommandPalette.test.tsx`, 각 `*.wiring.test.tsx`

**TDD Slice Contract:**
- Public interface: FloatingPanel (pop-out/dock), ContextMenu (13 items, keyboard nav), CommandPalette (Ctrl+Shift+P, 14 commands, filter)
- Behavior under test: pop-out → 별도 BrowserWindow, dock → 복귀, 최소화 독립성, 우클릭 → 메뉴, Arrow+Enter → 실행, Ctrl+Shift+P → 팔레트, 검색 필터
- Test oracle: BrowserWindow 생성/닫기 검증, 메뉴 항목 수 검증, 필터 결과 검증
- Required setup/fixtures: Playwright Electron (e2e), store mock (component)
- Minimal implementation boundary: 3 기능 모두 구현
- Non-goals: 커스텀 컨텍스트 메뉴 항목, 플러그인 명령 확장

**Impact scope:**
- (a) Reference breakage: `src/preload/index.ts` — ElectronAPI 인터페이스에 floating panel 채널 추가, 기존 타입 시그니처 변경 없음 (additive)
- (b) Call site info: `src/renderer/hooks/useKeyboardShortcuts.ts` — Ctrl+Shift+P 바인딩 추가
- (c) Code preservation: `src/main/index.ts` — squirrel-startup guard, app.whenReady() 구조, 기존 register*Handlers() 호출 체인 보존; `src/renderer/App.tsx` — 기존 TitleBar/TabBar/SplitContainer/Rail/StatusBar 레이아웃 구조 보존

**Operational decisions:** none applicable
**Depends on:** Task 8, Task 9, Task 10 (floating panels need actual panel content)
**File overlap with:** Task 12 (useKeyboardShortcuts)

**Completion criteria (from spec):**
- [ ] AC-L4-01-1: Pop-out / Verify: `pnpm test:e2e -- --grep "Float pop-out"`
- [ ] AC-L4-01-2: Dock / Verify: `pnpm test:e2e -- --grep "Float dock"`
- [ ] AC-L4-01-3: 최소화 독립 / Verify: `pnpm test:e2e -- --grep "Float minimize independent"`
- [ ] AC-L4-01-N1: 강제 종료 / Verify: `pnpm test:e2e -- --grep "Float force close"`
- [ ] AC-L4-02-1: 메뉴 표시 / Verify: `pnpm test -- --grep "ContextMenu show"`
- [ ] AC-L4-02-2: 키보드 네비게이션 / Verify: `pnpm test -- --grep "ContextMenu keyboard"`
- [ ] AC-L4-02-3: 화면 경계 / Verify: `pnpm test -- --grep "ContextMenu overflow"`
- [ ] AC-L4-02-N1: Copy 비활성 / Verify: `pnpm test -- --grep "ContextMenu copy disabled"`
- [ ] AC-L4-03-1: 팔레트 표시 / Verify: `pnpm test:e2e -- --grep "Palette show"`
- [ ] AC-L4-03-2: Substring 필터 / Verify: `pnpm test -- --grep "Palette filter"`
- [ ] AC-L4-03-3: 명령 실행 / Verify: `pnpm test -- --grep "Palette execute"`
- [ ] AC-L4-03-N1: 필터 결과 없음 / Verify: `pnpm test -- --grep "Palette no match"`

**Verification method:** e2e + component test Verify commands.
**View wiring verification:** `ContextMenu.wiring.test.tsx`, `CommandPalette.wiring.test.tsx`
**Wiring probe:**
- Entry point: `src/renderer/main.tsx` | Module: `src/renderer/components/ContextMenu/ContextMenu.tsx` | Probe type: `import-chain` | Verify: `pnpm typecheck`
- Entry point: `src/renderer/main.tsx` | Module: `src/renderer/components/CommandPalette/CommandPalette.tsx` | Probe type: `import-chain` | Verify: `pnpm typecheck`

- [ ] Step 1-4: TDD for ContextMenu (component).
- [ ] Step 5-8: TDD for CommandPalette (component + e2e).
- [ ] Step 9-12: TDD for FloatingPanel (e2e).
- [ ] Step 13: Add Ctrl+Shift+P binding.
- [ ] Step 14: Wire ContextMenu + CommandPalette in App.tsx.
- [ ] Step 15: Run all Verify commands → pass.
- [ ] Step 16: Commit.

---

## Task 12: Find Bar + Save Scrollback [R-L4-04, R-L4-05] {feature}

**ASR:** none
**Files:**
- Create: `src/renderer/components/FindBar/FindBar.tsx`, `FindBar.module.css`, `index.ts`
- Modify: `src/renderer/components/Terminal/TerminalView.tsx`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/hooks/useKeyboardShortcuts.ts`
- Test: `tests/component/FindBar.test.tsx`, `tests/component/FindBar.wiring.test.tsx`, `tests/component/Scrollback.test.tsx`

**TDD Slice Contract:**
- Public interface: FindBar (Ctrl+F open, search, next/prev, ESC close), Save Scrollback (serialize + SaveAs dialog)
- Behavior under test: Ctrl+F → 검색 바, 검색어 → findNext 하이라이트, ESC → 닫힘, 저장 → SerializeAddon + dialog
- Test oracle: FindBar 표시/숨김 상태, 하이라이트 호출 확인, serialize 결과 확인
- Required setup/fixtures: xterm mock (SearchAddon, SerializeAddon), electron dialog mock
- Minimal implementation boundary: FindBar UI + SearchAddon, serialize + SaveAs
- Non-goals: 정규식 검색, 다중 파일 검색

**Impact scope:**
- (a) Reference breakage: `src/preload/index.ts` — scrollback save dialog 채널 추가 (additive)
- (b) Call site info: `src/renderer/components/Terminal/TerminalView.tsx` — SearchAddon + SerializeAddon loadAddon
- (b) Call site info: `src/renderer/hooks/useKeyboardShortcuts.ts` — Ctrl+F 바인딩
- (c) Code preservation: `src/main/index.ts` — squirrel-startup guard, 기존 handler 등록 보존; `src/renderer/components/Terminal/TerminalView.tsx` — 기존 WebGL/FitAddon 로딩 로직, unmount dispose 로직 보존

**Operational decisions:** none applicable
**Depends on:** Task 6 (keyboard shortcuts system)
**File overlap with:** Task 11 (useKeyboardShortcuts)

**Completion criteria (from spec):**
- [ ] AC-L4-04-1: Scrollback 내보내기 / Verify: `pnpm test -- --grep "Scrollback save"`
- [ ] AC-L4-05-1: Find bar Ctrl+F / Verify: `pnpm test -- --grep "FindBar show"`
- [ ] AC-L4-05-2: 검색 하이라이트 / Verify: `pnpm test -- --grep "FindBar search"`
- [ ] AC-L4-05-3: ESC 닫기 / Verify: `pnpm test -- --grep "FindBar close"`
- [ ] AC-L4-05-N1: 검색 결과 없음 / Verify: `pnpm test -- --grep "FindBar no results"`

**Verification method:** Component test Verify commands.
**View wiring verification:** `tests/component/FindBar.wiring.test.tsx` — W1 binding (SearchAddon → highlight), W2 handler (Enter → findNext)
**Wiring probe:**
- Entry point: `src/renderer/main.tsx` | Module: `src/renderer/components/FindBar/FindBar.tsx` | Probe type: `import-chain` | Verify: `pnpm typecheck`

- [ ] Step 1-4: TDD for FindBar (component).
- [ ] Step 5-6: TDD for Scrollback save.
- [ ] Step 7: Load SearchAddon + SerializeAddon in TerminalView.
- [ ] Step 8: Add Ctrl+F binding.
- [ ] Step 9: Run Verify commands → pass.
- [ ] Step 10: Commit.

---

## Integration Contract Matrix

| WM ID | Producer Task | Consumer Task | Contract | First Connected | Verify |
|-------|---------------|---------------|----------|-----------------|--------|
| WM-REG-1 | T1 | T2, T8, T9, T10 | `ipcMain.handle/on` handlers in main/index.ts | T1 | `pnpm test:e2e -- --grep "Terminal echo"` |
| WM-REG-2 | T1 | T2, T3 | `PtyManager.sessions: Map<string, IPty>` | T1 | `pnpm test -- --grep "PtyManager create"` |
| WM-REG-3 | T1 | T4, T5, T7, T11 | React component tree in App.tsx | T4 | `pnpm typecheck` |
| WM-REG-4 | T3 | T5, T6, T7 | `useStore` hook + 4 slices | T5 | `pnpm test -- --grep "Store creation"` |
| WM-REG-5 | T1 | T2, T12 | `Terminal.loadAddon()` in TerminalView | T2 | `pnpm test -- --grep "TerminalView webgl"` |
| WM-REG-6 | T7 | T8, T9, T10 | `useVisibilityLifecycle({ start, stop })` | T8 | `pnpm test -- --grep "visibility start"` |
| WM-REG-7 | T10 | T10 | `protocol.handle("ezterm-file", ...)` in main | T10 | `pnpm test -- --grep "Protocol traversal"` |
| WM-REG-8 | T10 | T10 | `chokidar.watch(cwd)` in filesystem.ts | T10 | `pnpm test -- --grep "FilesPanel watch"` |
| WM-REG-9 | T1 | T2 | `FrameBuffer.push(id, data)` | T1 | `pnpm test -- --grep "FrameBuffer coalesce"` |
| WM-C-1 | T2 | T8, T9, T10 | `IpcResult<T>` union type | T2 | `pnpm typecheck` |
| WM-C-2 | T2 | T3 | `PtyManager.killAll()` on before-quit | T2 | `pnpm test -- --grep "PtyManager cleanup"` |
| WM-C-3 | T7 | T8, T9, T10 | `useVisibilityLifecycle` start/stop callbacks | T8 | `pnpm test -- --grep "visibility start"` |
| WM-C-5 | T2 | T6 | WebGL dispose on tab hide, recreate on show | T6 | `pnpm test:e2e -- --grep "Tab switch"` |
| WM-C-6 | T3 | T6 | Cross-slice `get()` in closeTab action | T3 | `pnpm test -- --grep "cross-slice closeTab"` |
| WM-DF-1 | T1 | -- | keypress → pty:write → stdout → frame-buffer → pty:data → xterm.write | T1 | `pnpm test:e2e -- --grep "Terminal echo"` |
| WM-DF-3 | T10 | -- | settings:load → file → renderer; save → atomic write | T10 | `pnpm test -- --grep "Settings file load"` |
| WM-DF-4 | T8 | -- | metrics:start → SI poll → metrics:update → StatusPanel | T8 | `pnpm test -- --grep "Metrics push"` |
| WM-DF-5 | T9 | -- | network:start → cap/SI → network:traffic → NetworkPanel | T9 | `pnpm test -- --grep "Network traffic stats"` |
| WM-DF-6 | T10 | -- | OSC 7 CWD → chokidar → IPC → file tree | T10 | `pnpm test -- --grep "FilesPanel CWD OSC7"` |
| WM-DF-7 | T3 | T4 | action → layoutSlice → LayoutNode → CSS Grid | T4 | `pnpm test -- --grep "SplitContainer render"` |
| WM-DF-8 | T10 | -- | click → ezterm-file:// → preview | T10 | `pnpm test -- --grep "Preview text"` |
| WM-DF-9 | T10 | -- | save → main write → broadcast all renderers | T10 | `pnpm test -- --grep "Settings apply"` |

---

## Full-Feature Wiring Gate

**Required:** yes
**Verify-type:** e2e
**Covers:** T1 → T2 → T3 → T4 → T5 → T6 → T7
**Expected observation:** 앱 시작, 터미널 I/O 정상, 탭 생성/닫기/전환, pane 분할/닫기, Rail 패널 토글, 셸 프롬프트 3초 이내
**Verify:** `pnpm test:e2e --grep smoke`

---

## Agent Assignment

| Task | Agent | Mode | Reason |
|------|-------|------|--------|
| T1 | subagent | isolated | Skeleton: 모든 entry point 최초 wiring |
| T2 | subagent | sequential (after T1) | T1 파일 수정 — 순차 필요 |
| T3 | subagent | sequential (after T2) | Shared types 의존 |
| T4 | subagent | parallel (with T5) | SplitContainer 독립 |
| T5 | subagent | parallel (with T4) | UI Chrome 독립 |
| T6 | subagent | sequential (after T4, T5) | 전체 L2 통합 |
| T7 | subagent | sequential (after T6) | App.tsx 레이아웃 변경 |
| T8 | subagent | parallel (with T9, T10, T12) | 독립 main 모듈 |
| T9 | subagent | parallel (with T8, T10, T12) | 독립 main 모듈 |
| T10 | subagent | parallel (with T8, T9, T12) | 독립 main 모듈 (단 preload 수정으로 T8/T9와 main/index.ts 병합 주의) |
| T11 | subagent | sequential (after T8, T9, T10) | L4 통합 |
| T12 | subagent | parallel (with T8, T9, T10) | TerminalView만 수정, 독립 |

---

## Dependency Graph

```
T1 {skeleton}
 |
T2 (L1 hardening)
 |
T3 (Store + Tabs + Panes)
 |
 +--- T4 (SplitContainer) ---+
 |                            |--- T6 (Keyboard)
 +--- T5 (UI Chrome) --------+        |
                                       T7 (Rail + Visibility)
                                       |
                         +------+------+------+
                         |      |      |      |
                        T8    T9    T10    T12
                      (Status)(Net)(Files) (Find)
                         |      |      |
                         +------+------+
                                |
                              T11
                        (Float+Ctx+Cmd)
```

Critical path: T1 → T2 → T3 → T4/T5 → T6 → T7 → T8/T9/T10 → T11 (8 sequential steps)
Parallel slots: {T4, T5}, {T8, T9, T10, T12}

---

## File Overlap Risk Matrix

| File | Tasks | Mitigation |
|------|-------|------------|
| `src/main/index.ts` | T1, T2, T5, T8, T9, T10, T11, T12 | 각 태스크가 독립 `register*Handlers()` 함수를 자체 모듈에 생성, main에서는 import+call만 |
| `src/preload/index.ts` | T1, T2, T10, T11, T12 | T2에서 타입 완성 후 T10/T11/T12에서 채널 추가 |
| `src/renderer/App.tsx` | T1, T4, T5, T7, T11 | T1 → T4/T5 → T7 → T11 순차 |
| `src/renderer/components/Terminal/TerminalView.tsx` | T1, T2, T6, T12 | 순차 실행 |
| `src/renderer/hooks/useKeyboardShortcuts.ts` | T6, T11, T12 | T6에서 생성, T11/T12에서 바인딩 추가 |

---

## Risk Summary

| Risk | Severity | Task | Mitigation |
|------|----------|------|------------|
| main/index.ts 병합 충돌 | Medium | T8/T9/T10 병렬 | register 함수 분리 패턴 |
| node-pty Windows 빌드 실패 | High | T1 | 이미 설치됨, 테스트에서 mock 사용 |
| xterm WebGL in CI | Medium | T2, T6 | 컴포넌트 테스트에서 mock, e2e는 headless Electron |
| Task 10 크기 (4 requirements) | Medium | T10 | 파일 시스템 + 설정은 동일 패턴 반복, 분리 시 preload/main 중복 수정 증가 |
| tsconfig shared 경로 누락 | High | T1 | Step 3에서 즉시 해결 |
