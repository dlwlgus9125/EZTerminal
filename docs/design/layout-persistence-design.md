# Track A ③ — Layout Presets & Persistence (Design, A-M0)

> Status: **GATED — Codex REVISE(6 blockers) folded (2026-07-02). Ready for A-M1.**
> Gate record: `docs/research/2026-07-02-codex-track-a-presets-review.md`
> Baseline: 5a69b1d + Stage 0/B partial · Scope: the app's FIRST persistence layer.
> Layout geometry only — session state(cwd/env/vars/history)·블록 내용·PTY는 비영속.

## 0. Hard constraints

- **B1/B5 (Track A P1 gate):** 복원 패널은 영속된 sessionId를 절대 재사용하지 않는다.
  `fromJSON` 후 각 패널은 새 `create-session`을 발급받는다 (구조적으로 보장, §6).
- Main이 fs를 단독 소유. 렌더러는 fs 직접 접근 금지. IPC는 additive만.
- **v1은 single-window 전용** (gate 추가 발견): 멀티윈도우 도입 시 last-writer-wins
  재설계 필요 — 그 전까지 창은 1개라고 명시적으로 선언한다.
- **`reuseExistingPanels`는 v1에서 절대 사용 금지** (gate Q1): 시작 복원은 라이브 패널이
  없어 무의미하고, 프리셋 적용은 "전체 teardown + 새 세션" 단일 의미론을 유지한다.
- 와이어링 우선 · 가드/e2e 필수 · 패키지 스모크 필수.

## 1. Verified facts (dockview-core 7.0.2 — Codex 감사 완료)

| # | Fact | Codex 감사 |
|---|------|-----------|
| F1 | `toJSON()`은 `{id, contentComponent, tabComponent, params(빈 경우 undefined), title, renderer, min/max}` 직렬화 (`dockviewPanel.js:142-157`) | CONFIRMED |
| F2 | `renderer:'always'`는 라운드트립 보존 (`deserializer.js:24-30`) | CONFIRMED |
| F3 | 옵션 없는 `fromJSON`은 `addPanel`과 동일한 content-component mount 경로 → TerminalPane mount → 새 createSession. 단 `reuseExistingPanels` 경로는 예외(재사용) → §0에서 금지 | PARTIALLY — 금지로 해소 |
| F4 | deserialize 실패 시 revert+re-throw가 있으나(`:2052-2110`) **`clear()` 후 try 진입 전**(`:1932-1938`)에 malformed `grid.root`로 throw 가능 → revert가 못 덮는 창이 있음 | PARTIALLY → **B1: 사전 검증 + 백업 필수** |
| F5 | 패널 params 미사용; sessionId는 TerminalPane 컴포넌트 상태에만 존재 | CONFIRMED |
| F6 | 패널 id는 모듈 카운터 `tab-N`; 복원은 원본 id 보존; 중복 addPanel id는 throw(`:2412-2416`) → **재시드 필수** | CONFIRMED |

## 2. Files & data flow

```
src/shared/layout-schema.ts    (new)  버전드 Zod 엔벨로프 + 새니타이저 (main↔renderer 공유)
src/main/layout-store.ts       (new)  fs 소유: read/validate/원자쓰기/격리(quarantine)
src/main/main.ts               (mod)  IPC 핸들러(layout:*/presets:*/settings) + EZTERMINAL_USER_DATA_DIR seam
src/preload/preload.ts         (mod)  invoke 래퍼
src/shared/ipc.ts              (mod)  EzTerminalApi 확장
src/renderer/App.tsx           (mod)  복원 트랜잭션·재시드·디바운스 저장·프리셋 UI·__ezLayoutFlush/__ezSessions seam
src/renderer/TerminalPane.tsx  (mod)  createSession 취소 가드 + data-session-id 노출
e2e/layout-persistence.spec.ts (new)  재시작 복원 / 손상 매트릭스 / 프리셋 / 재시드 충돌
```

## 3. Schema & sanitizer (`src/shared/layout-schema.ts`) — B1/B4/B5 반영

```ts
// 패널: 앱 불변식을 스키마로 강제 (B5)
const PanelSchema = z.object({
  id: z.string().min(1),
  contentComponent: z.literal('terminal'),   // 알 수 없는 컴포넌트 = React throw → 거부
  title: z.string().optional(),
  renderer: z.literal('always').optional(),  // 로드 시 'always'로 정규화
  params: z.object({}).strict().optional(),  // sessionId류 어떤 키도 거부 (B5)
  tabComponent: z.undefined().or(z.string().optional()),
  minimumWidth: z.number().optional(), minimumHeight: z.number().optional(),
  maximumWidth: z.number().optional(), maximumHeight: z.number().optional(),
}).strict();

// 그리드: B1 — fromJSON의 "clear() 후 try 전 throw" 창을 막는 최소 루트 형태 검증
const GridSchema = z.object({
  root: z.object({ type: z.literal('branch'), data: z.array(z.unknown()) }).passthrough(),
  width: z.number(), height: z.number(), orientation: z.string(),
}).passthrough();

const LayoutSchema = z.object({
  grid: GridSchema,
  panels: z.record(z.string(), PanelSchema),
  activeGroup: z.string().optional(),
}).strict(); // floatingGroups/popoutGroups/edgeGroups는 스키마 밖 (B4)

export const LayoutEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  savedAt: z.string(),
  layout: LayoutSchema,
});
```

- **새니타이저(저장·로드 공용):** ① `floatingGroups`/`popoutGroups`/`edgeGroups` 삭제(B4)
  ② `renderer:'always'` 강제. **`params`는 스트립하지 않는다** — 비어있지 않은 params(특히
  sessionId)는 검증에서 **거부**(조용한 스트립은 부활 회귀를 은폐). ③ 검증 단계: panels
  레코드 key ≠ panel.id 거부(B5) ④ 패널 수 상한 `MAX_PANELS = 64` (B5 bounded).
- 버전 불일치 → 손상 경로. 마이그레이션 훅 = `switch(version)` case 1만.
- 프리셋 파일: `Record<name, LayoutEnvelope>`; 이름 1..64자, 경로 의미 없음.
- **시작 레이아웃 설정은 `settings.json`** (gate Q5): `{ schemaVersion:1, startup: {mode:'last'|'preset', presetName?} }`
  — Stage E1 설정 스토어가 이 파일을 그대로 인수.

## 4. Main-process store (`src/main/layout-store.ts`) — 원자성 구체화 (gate 추가 발견)

- 파일: `userData/layout.json` · `presets.json` · `settings.json`. 테스트 seam:
  `EZTERMINAL_USER_DATA_DIR` env → `app.setPath('userData')` (ready 전, main.ts).
- **원자 쓰기 프로토콜:** `layout.json.tmp`에 write → `rename(tmp → layout.json)`.
  - 시작 시 stale `*.tmp` 잔재는 무조건 삭제 (크래시 잔재).
  - rename 실패(EPERM 등 Windows 잠금): 1회 재시도 후 로그+드롭 (다음 디바운스가 재시도).
  - 쓰기 직렬화: in-flight 1개 + latest-pending 1개 (중간 상태 드롭 가능 — 최신만 의미).
- **읽기:** parse → sanitize → Zod validate. ENOENT → `null`. 그 외 실패 →
  `layout.json.corrupt`로 rename (기존 .corrupt는 **덮어씀** — 정책: 최신 증거 1개만 유지,
  문서화) → `null` 반환.
- **저장 검증:** IPC로 받은 raw layout도 동일 sanitize+validate (B5 — main은 렌더러를
  신뢰하지 않음). 실패는 프로그래밍 에러: 로그+드롭, 절대 쓰지 않음.

## 5. IPC (additive)

| invoke 채널 | 요청 | 응답 |
|---|---|---|
| `layout:load` | — | `LayoutEnvelope \| null` |
| `layout:save` | raw `SerializedDockview` | `void` (main이 sanitize+wrap) |
| `layout:quarantine` | — | `Promise<void>` (**awaitable** — B3) |
| `presets:list` | — | `string[]` |
| `presets:save` / `presets:get` / `presets:delete` | `{name(,layout)}` | … |
| `settings:get-startup` / `settings:set-startup` | `StartupPref` | … |

## 6. Renderer restore TRANSACTION (`App.tsx`) — B1/B2/B3 반영

복원·프리셋 적용은 아래 프로토콜을 따르는 단일 트랜잭션이다:

```
restoreGeneration += 1; const gen = restoreGeneration;   // B2: 세대 토큰
savesSuppressed = true;                                   // B2/B3: 복원 중 저장 금지
try {
  envelope = await loadLayout();                          // (프리셋이면 presets:get)
  if (gen !== restoreGeneration || disposed) return;      // stale 완료 무시 (StrictMode)
  if (envelope) {
    backup = api.panels.length ? api.toJSON() : null;     // B1: 적용 전 백업 (프리셋 경로)
    reseedTabCounter(envelope.layout);                    // F6 — fromJSON 전
    try {
      api.fromJSON(envelope.layout);                      // 옵션 없음 (reuseExistingPanels 금지)
      if (api.panels.length === 0) throw new Error('empty layout');
    } catch {
      await window.ezterminal.quarantineLayout();         // B3: await — 저장 재개 전에 완료
      if (backup) api.fromJSON(backup); else addTab();    // B1: 백업 복귀 or 기본
    }
  } else addTab();
} finally {
  if (gen === restoreGeneration) {
    savesSuppressed = false;
    attachSaveListenerOnce();                             // B2: 복원 settle 후에만 구독
  }
}
```

- **저장:** `onDidLayoutChange` → 300ms 디바운스 → `saveLayout(api.toJSON())`.
  `savesSuppressed` 동안 무시. 정상 종료의 <300ms 손실 창은 **v1 수용·문서화** (gate Q2);
  `beforeunload` best-effort flush는 유지하되 load-bearing 아님.
- **e2e seam:** `window.__ezLayoutFlush()` (디바운스 취소+즉시 저장 await),
  `window.__ezSessions()` (라이브 세션 수 — B6 누수 단언용).
- **재시드:** `tabCounter = max(tabCounter, …/^tab-(\d+)$/ suffixes)` — e2e가
  "복원 후 새 탭 id === tab-(max+1)"을 단언 (B6).
- **TerminalPane 가드 (부채 (f) 흡수):** mount effect에 cancelled 플래그 — cleanup 후
  resolve된 createSession은 즉시 destroy (StrictMode 이중 mount + fromJSON N-패널 버스트).
  pane 루트에 `data-session-id` 노출 (B6).

## 7. Presets & startup (A-M4)

- 헤더 버튼(기존 `.btn` 스타일): Save preset… / Presets ▾ (apply / set-startup / delete).
- 적용 = §6 트랜잭션 (confirm() 선행 — 라이브 세션 파괴 경고). 옛 패널 unmount →
  기존 dispose 경로가 세션 파괴 (B6 e2e가 `__ezSessions()`로 누수 0 단언).
- 시작 설정: `'last'`(기본) | 프리셋 이름 — `settings.json` (§3).

## 8. e2e matrix (A-M5) — B6 반영

`e2e/layout-persistence.spec.ts`, 전부 `EZTERMINAL_USER_DATA_DIR=<tmp>`:

1. **재시작 복원:** 3패널 구성 → pane별 `data-session-id` 기록 → `__ezLayoutFlush()` →
   relaunch → 배치 동일(toJSON 시그니처) + **모든 sessionId 상이** + 기능 정상(cwd 격리,
   pre-restart `cd` 타깃이 **아님** = 상태가 새것).
2. **재시드 충돌 방지:** 복원(tab-1..3) → `+ Tab` → `__ezDock.panels`에 `tab-4` 존재 단언.
3. **손상 매트릭스** (generic garbage 하나가 아니라 표적 형태들):
   a. 쓰레기 바이트 → 기본 1패널 + `.corrupt` 생성
   b. `grid.root.type !== 'branch'` (B1의 pre-try throw 창) → 기본 + 격리
   c. `params: {sessionId: 'stale'}` → 스키마 거부 → 기본 + 격리
   d. `contentComponent: 'unknown'` → 거부 → 기본 + 격리
   e. `edgeGroups` 포함 → 새니타이저 strip 후 정상 복원 (거부 아님)
   f. 패널 0개 레이아웃 → 기본 + 격리
   g. `schemaVersion: 99` → 기본 + 격리
4. **프리셋:** 저장 → 레이아웃 변형 → 적용(confirm 수락) → 배치 복원 + 전부 새 sessionId +
   `__ezSessions()` === 패널 수 (누수 0).
5. **패키지드 스모크 +1 단언:** temp userData로 저장→relaunch→복원.

유닛: 스키마(라운드트립/각 손상 형태/strip 동작/버전), 스토어(원자성/stale tmp/격리 정책),
재시드 함수.

## 9. Risks (갱신)

| Risk | Mitigation |
|---|---|
| dockview 내부 형태 드리프트 → 구파일 fromJSON throw | 스키마 최소 루트 검증(B1) + 트랜잭션 catch → 격리 + 백업/기본 |
| StrictMode/HMR로 onReady 재진입·stale 완료 | 세대 토큰 + disposed 체크 (B2) |
| 격리 vs 폴백 저장 레이스 | 저장 억제 + awaitable quarantine (B3) |
| 렌더러가 보낸 악성/깨진 레이아웃 | main 측 sanitize+validate, 상한 64패널 (B5) |
| quit 직전 <300ms 변경 손실 | v1 수용+문서화, best-effort flush (gate Q2) |
| 프리셋 적용 실수로 라이브 세션 소실 | confirm() + 백업 복귀 경로 (B1) |
| Windows rename 잠금 실패 | 1회 재시도+드롭, stale tmp 시작 시 청소 (§4) |

## 10. Resolved questions (was: open)

전부 게이트에서 답변됨 — `docs/research/2026-07-02-codex-track-a-presets-review.md` §Answers 참조.
잔여 열린 항목 없음. A-M1 진행 가능.
