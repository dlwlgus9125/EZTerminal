# EZTerminal — Roadmap

> **이 문서는 프로젝트의 영속적 단일 진실원본(source of truth)입니다.**
> 과거에 전체 코드가 유실된 적이 있어, 비전과 단계는 반드시 저장소에 커밋되어야 합니다.
> 상세 1차 스펙: deep-interview 산출물 (`~/.claude/plans/agile-stargazing-plum.md`).
> 최초 작성: 2026-06-29 (deep-interview 14R, 모호도 14.5%로 확정).

---

## 비전 (What this is)

EZTerminal은 **"기존 터미널 래퍼"가 아니라 자체 셸(명령 해석기)** 입니다.
명령 결과가 텍스트가 아니라 **구조화 데이터**로 흐르고, **명령마다 블록 UI**로 표·리스트가 자동 렌더되며, 위에 AI가 얹히는 **차세대 셸** — Warp(블록 UI) + Nushell(구조화 데이터) + AI 계열.

의존 순서: **구조화 데이터(토대) → 리치 블록 렌더(표현) → AI(상위 레이어).**

핵심 정체성: 직접 만드는 "새 것"은 **작은 대화형 파이프 문법 + 구조화 값 모델 + 블록 UI** 로 한정.
새 *프로그래밍* 언어는 발명하지 않음(스크립팅은 JS/TS 임베드 또는 후순위).

---

## 기술 방향

- **앱/UI:** Electron + React + TypeScript
- **셸 인터프리터:** TS/Node 자체 구현 (렉서/파서 → 구조화 값 모델 → 파이프라인 실행)
- **외부 프로그램:** `child_process` 텍스트 캡처 (1차). PTY/`xterm.js`는 TUI 도입(2차) 때.
- **플랫폼:** Windows 10/11 우선 → 크로스플랫폼은 후순위

---

## Phase 1 — 구조화 셸 + 블록 UI 토대 (현재 목표)

**완성 기준 (Acceptance Criteria):**

- [x] 1. 명령 입력 시 **블록**(입력+출력 묶음, 접기/펼치기)으로 표시
- [x] 2. 내장 명령이 **구조화 데이터 → 표**로 렌더 — `ls`·`gen-rows`·`cd`·`ps`·`history` 완료 (모두 구조화 테이블; `ps`는 Windows-first `tasklist` 소스)
- [x] 3. **구조화 파이프라인**: `ls | where size > 100mb | sort-by name` → 필터된 표
- [x] 4. **변수 · 환경변수 · 히스토리** — 변수(`let`/`$x`) · 환경변수(`$env.X` read + `$env.X = …` write) · `cd`(영속 세션 cwd) 완료 (AC#4-A) · **히스토리(입력 ↑/↓ recall + `history` builtin) 완료 (AC#4-B)**. 영속 상태는 utilityProcess당 1개의 `ShellSession`이 소유(cwd/env/variables/history), ExecutionSession은 그 위의 per-command 실행.
- [x] 5. **외부 프로그램**(node 등) 실행 → 텍스트 블록 (ANSI→HTML, 새니타이즈)
- [x] 6. **Windows 패키지 exe** 스모크 — `test:e2e:packaged`로 fused exe의 utilityProcess asar-fork 검증
- [x] 7. **로드맵 문서**(이 파일)가 저장소에 존재

> **Phase 1 완료:** AC#1–7 전부 충족 (`ps`는 Windows-first, 크로스플랫폼 프로세스 소스는 후순위 증분).

**Phase 1 비포함(Non-Goals):** 아래 Phase 2+ 항목 전부.

---

## Phase 2+ — 차세대 기능 (보류, 순서 미확정)

| 항목 | 내용 | 비고 |
|---|---|---|
| **AI 보조** | 자연어↔명령, 설명·자동수정 | 비전의 상위 레이어 |
| ✅ **풀스크린 TUI** | vim/htop/claude 등 | **완료(2026-06-30)** — `node-pty`(ConPTY) + `@xterm/xterm`, 블록 내 진짜 터미널 영역. ~~`!cmd` 프리픽스로 트리거(단독 외부만; 파이프/빌트인/배치는 거부)~~ → **2026-07-03 CLI 패리티로 대체**: sigil 없이 자동 PTY + 배치 shim 허용 + 적응 렌더, `!`=강제 xterm (아래 진행 현황 참조). |
| ✅ **풀 스크립팅** | if/for/함수/스크립트 파일 | **완료(2026-07-02)** — `run-script <path> [args]`: 스크립트당 script-host utilityProcess(main 브로커드; RunAsNode:false 제약), `ez.run()` 인라인 evaluate(세션 공유·취소 상속·직렬화), rows 반환→표/텍스트. Codex 게이트 4블로커 반영. TS 트랜스파일·인라인 문법은 후속 |
| ✅ **드래그 레이아웃 편집기 + 프리셋** | 탭/분할/세션 프리셋, "현재 레이아웃 저장/복원", 기본 시작 레이아웃 | **전부 완료.** Phase 1(2026-07-01): 멀티세션 백엔드 + dockview 탭(`renderer:'always'` PTY 생존). ① 분할(2026-07-01): 버튼+Alt+Shift+=/-. ② 드래그 편집기(2026-07-01): disableDnd 해제+disableFloatingGroups, 이동=re-parent라 세션 생존. **③ 프리셋·영속 완료(2026-07-02)** — 앱 최초 영속 계층: 버전드 Zod 엔벨로프(`src/shared/layout-schema.ts`) + main 소유 원자 스토어(`src/main/layout-store.ts`, tmp→rename, 손상 격리 `.corrupt`) + 복원 트랜잭션(세대 토큰, 저장 억제, tabCounter 재시드) + 프리셋 드롭다운/시작 레이아웃(`settings.json`). **복원 시 sessionId 부활 금지(B1/B5)가 스키마 불변식 + e2e로 증명됨.** Codex 게이트 REVISE 6블로커 반영: `docs/research/2026-07-02-codex-track-a-presets-review.md` |
| ✅ **테마/외형** | 색상·폰트·투명도·배경 | **완료(2026-07-02)** — dark/light/high-contrast 빌트인, settings.json 영속, xterm 라이브 재테마. 투명도·커스텀 색상은 후속 |
| ✅ **명령 팔레트 / 단축키** | 빠른 명령 실행 + 키 바인딩 | **완료(2026-07-02)** — Ctrl+Shift+P, 부분수열 필터, 프리셋/테마/탭/분할 액션, 키바인딩 테이블 중앙화 |
| ✅ **SSH/원격 접속** | 원격 세션 | **완료(2026-07-03)** — `ssh-connect user@host [--key <path>] [--port <n>]`: 전용 `runSshSession` 러너(PtyStreamData 재사용 안 함, gate B1) + TOFU(`known_hosts.json`, main 소유 원자 스토어) + `authHandler`로 호스트 검증이 자격증명 프롬프트보다 항상 선행. 채널 오픈 후 기존 PTY 백프레셔·렌더러 재사용. |
| 🔶 **크로스플랫폼** | Mac/Linux | **부분(2026-07-03)** — `ps` 크로스플랫폼 소스(`createProcessLister` 플랫폼 디스패치, POSIX `ps -eo` 파서 유닛검증). mac/linux 실검증·서명/공증·CI 매트릭스는 하드웨어 확보 시. |
| **자체 VT 에뮬레이터** | xterm.js 대체 | 선택적 "언젠가" — 사용자가 xterm.js로 확정 |

---

## 작업 원칙 (과거 학습 반영)

- **와이어링 우선:** 각 태스크에서 end-to-end 연결을 그때그때 검증 (마지막에 몰아서 X)
- **가드 스크립트 필수:** 자동 검증 스크립트는 항상 필수 (optional 금지)
- **패키지 스모크 필수:** dev E2E만으론 불충분 — 패키징 exe 별도 검증
- **복잡 아키텍처는 Codex 검증 먼저:** 자체 셸 인터프리터 설계 시 적용
- **native module 패키징:** (2차 node-pty 도입 시) Forge+Vite는 자동 포함 안 함 → packageAfterPrune hook 필수

---

## 진행 현황 / 다음 단계

- ✅ Deep-research (기술 + 인터프리터) — `docs/research/2026-06-29-*.md`
- ✅ Codex 아키텍처 검증 → 셸 코어 설계 **LOCKED** — `docs/design/shell-core-architecture.md`
- ✅ **첫 수직 슬라이스 빌드 완료 + 검증** (autopilot T0–T8) — 아래
- ✅ **AC#4-A 완료:** 변수(`let`/`$x`) · 환경변수(`$env.X`) · `cd`(영속 세션 cwd) + 영속 `ShellSession` — typecheck 0 · vitest 115 · e2e 9 · package exit 0
- ✅ **AC#4-B 완료:** 히스토리(입력 ↑/↓ recall + `history` builtin, 구조화 테이블) + `ps` builtin(Windows-first `tasklist` 소스, 테스트용 주입 seam) — typecheck 0 · vitest 128 · e2e 11 · package exit 0 → **Phase-1 AC#1–7 전부 완료**
- ✅ **Phase 2 풀스크린 TUI 완료 (2026-06-30):** `node-pty`(ConPTY) + `@xterm/xterm` — `!cmd`로 인터랙티브/풀스크린 프로그램(vim·htop·claude)이 블록 안 진짜 터미널에서 동작. M0 Codex 적대적 검증(4 blocker 반영) → M1 네이티브 패키징(packageAfterPrune + asar.unpack + guard) → M2 IPC additive(pty-data/pty-input/pty-resize) → M3 인터프리터 PtyRunner+pty-stream+PtySession(취소→cancelled one-shot 가드) → M4 `!` 렉서/파서/평가자 → M5 renderer xterm 블록 → M6 패키지 검증. 근거: `docs/research/2026-06-30-codex-phase2-architecture-review.md`.
- ✅ **Track A Phase 1 완료 (2026-07-01): 멀티세션 + dockview 탭.** M0 Codex 적대적 검증(verdict REVISE, 8 blocker 반영 → `docs/research/2026-07-01-codex-track-a-layout-review.md`) → M1 멀티세션 백엔드(`SessionRegistry`: 세션 create/destroy/canRun, 세션당 독립 cwd/env/vars/history, run 직렬화, runId 포트 상관, shared-fate) → M2 `TerminalPane` 추출(순수 리팩터) → M3 dockview 탭(탭=독립 세션, `renderer:'always'` PTY 생존, disableDnd 탭전용) → M4 패키지 스모크. typecheck 0 · vitest 169 · e2e 17 · packaged guardOK+2.
- ✅ **Track A 후속 ① 분할(splits) 완료 (2026-07-01):** 활성 패널을 오른쪽/아래로 분할 → 각 분할=독립 세션(멀티세션 백엔드 재사용). 렌더러 전용·additive: `api.addPanel({position})`이 `disableDnd`와 무관하게 분할 생성 → **disableDnd 유지**(마우스 드래그 분할/부유창은 ② 드래그 편집기 Phase). 헤더 버튼(Split →/↓) + 캡처단계 키바인딩(Alt+Shift+=/-, 입력 가로챔·타이핑 안 됨). `e2e/splits.spec.ts` +4(동시 독립 세션 cwd 격리 · 분할 PTY · 분할 닫기 · 키바인딩). typecheck 0 · vitest 169 · e2e 21(17+4) · packaged guardOK+2. 커밋 039ecfe.
- ✅ **Track A 후속 ② 드래그 레이아웃 편집기 완료 (2026-07-01):** `disableDnd` 해제 + `disableFloatingGroups`(Shift+드래그 부유창 차단; 평범한 드래그-분할/재배치는 계속 동작). 렌더러 전용. **핵심 안전성(dockview 7.0.2 소스 + e2e 검증): 이동=기존 패널 노드 re-parent → dockview는 리마운트 안 함 → 드래그해도 TerminalPane/세션/PTY 생존**(createSession/destroySession 미재호출). `e2e/drag-layout.spec.ts` +2(라이브 PTY 패널이 프로그램적 이동에도 생존=드래그와 동일 엔진; 탭 draggable). 기존 21 e2e green=DnD 켜도 회귀 없음. typecheck 0 · vitest 169 · e2e 23(21+2) · packaged guardOK+2. 커밋 5a69b1d.
- ✅ **프로덕션 고도화 개시 (2026-07-02):** 승인 플랜 `~/.claude/plans/zesty-wiggling-pony.md` (Stage 0→A→B→C→D→E).
  - **Stage 0 CI:** `.github/workflows/ci.yml`(windows-latest 7단계) + lint 0화 — 가동은 GitHub 원격 결정 대기.
  - **Track A ③ 프리셋·영속 완료:** Codex 게이트(REVISE 6블로커) → 버전드 Zod 스키마 → main 원자 스토어(`.corrupt` 격리) → 복원 트랜잭션(세대 토큰·재시드·저장 억제) → 프리셋 드롭다운+시작 프리셋. **sessionId 부활 금지(B1/B5) 스키마+e2e 증명.** e2e 격리 헬퍼(`e2e/launch-app.ts`) 도입.
  - **Stage B 부분:** B-M1 아이콘/인스톨러 · B-M2 릴리스 플로우(draft Release) · B-M3 env-gated 서명(자체서명 실증) + node-pty 패키지 트림(~45MB↓) · B-M6 url-guard 렌더러 한정.
  - **Stage C 부분:** progress 통지 스로틀 — "flake"로 알려졌던 100M행 취소 실패의 진짜 원인(메인스레드 포화) 해소. PTY firehose 백프레셔는 잔여(Codex 게이트부터).
  - **Stage D 완료:** 프레임 어휘 addendum · parser 판별 유니온 · **CVE 전부 해소(audit 0)** — vitest 3.2·vite 6.4·tar/tmp overrides.
  - 검증: typecheck/lint 0 · vitest 204 · e2e 28 · packaged 4+guard · audit 0.
- ✅ **B-M5 크래시/진단 (2026-07-02):** 로컬 전용 crashReporter + main.log 로테이션 + 덤프 keep-10 + 크래시 배너(외부 kill e2e 검증).
- ✅ **Stage C PTY 백프레셔 완료 (2026-07-02):** Codex 게이트(REVISE 4블로커 — `docs/research/2026-07-02-codex-pty-backpressure-review.md`) → **바이트-ack 프로토콜**(행 credit 동형: 렌더러가 xterm flush 시점에만 누적 ack, 인터프리터가 sent-acked>1MiB pause / ≤256KiB resume → in-flight 구성적 유계). 실측 2건: ① pause()=ConPTY 워커 홉 너머 실제 배압 ② 플레인 node 러너에서 hot-firehose kill()은 이벤트 루프를 동기 wedge(앱의 Electron utilityProcess 경로는 동일 시나리오 통과 — resume-then-kill 계약) → 패키지드 테스트는 Ctrl+C 협조 종료.
- ✅ **E1 테마 완료 (2026-07-02, Sonnet 위임 빌드):** dark/light/high-contrast — `themes.ts` 단일 소스 + `[data-theme]` CSS 변수 + xterm 라이브 재테마(`ez:theme`) + settings.json 영속(setStartup 덮어쓰기 버그 수정 포함).
- ✅ **E2 명령 팔레트 완료 (2026-07-02, Sonnet 위임 빌드):** Ctrl+Shift+P 오버레이(부분수열 필터, `fuzzy.ts` 유닛테스트), 프리셋·테마·탭·분할 액션, App.tsx 키바인딩 테이블 중앙화(기존 콤보 규율 유지). 베이스라인: vitest 228 · e2e 35 · packaged 5.
- ✅ **E4 스크립팅 완료 (2026-07-02, Sonnet 위임 빌드):** Codex 게이트(REVISE 4 — `docs/research/2026-07-02-codex-scripting-review.md`) → script-host utilityProcess(main의 `ScriptHostRegistry`, hostId spawn/kill/exit + interpreter 사망 시 전체 kill) + `ez.run()` 인라인 evaluate(FIFO 직렬화, 100k rows/8MB print 증분 상한) + stdout/stderr 패치→script-print 포트 직송. 베이스라인: **vitest 243 · e2e 40 · packaged 6**.
- ✅ **E5 SSH 완료 (2026-07-03, Sonnet 위임 빌드):** Codex 게이트(REVISE 4블로커 — `docs/research/2026-07-03-codex-ssh-review.md`) → `ssh2`(Option B: pure-JS, `onlyBuiltDependencies` 미등재로 `cpu-features` 네이티브 빌드 차단 확인) + `SshStreamData`/전용 `runSshSession`(`src/interpreter/ssh-session.ts`) + `external/ssh-client.ts` 어댑터(ssh2 유일 임포트 지점) + main `KnownHostsStore`(버전드 envelope, 원자쓰기, 격리 — layout-store 패턴) + 렌더러 `ssh-prompt` 카드(비밀번호 미로그). **호스트 검증→인증 순서 버그 발견+수정**: 최초 구현은 자격증명을 `connect()` 이전에 프롬프트해 TOFU보다 먼저 나타났음 — ssh2 `authHandler` 미들웨어로 자격증명 해석을 연기해 KEX/호스트 검증이 항상 먼저 완료되도록 수정(설계 명세와 정상 SSH 보안 UX에 맞춤). `pause()`가 실제 SSH 윈도우를 동결시킴을 실제 ssh2 Server+Client in-process 테스트로 실증(게이트 B2 NEEDS-INSTALL-VERIFY 해소). 베이스라인: **vitest 303 · e2e 44 · packaged 7 · audit 0**.
- ✅ **CLI 패리티 완료 (2026-07-03, team 실행 — Sonnet 워커 3 + Codex 게이트 + 독립 verifier):** "claude/codex 등 일반 터미널 CLI가 sigil 없이 실행돼야" — deep-interview(5R, ambiguity 18.75%) → 컨센서스 플랜(rev.7, Architect×3·Critic×3, 블로커 7건 해소) → M0a 실측 스파이크(**claude/codex는 `?2004h`+`?1004h` 입력모드 신호 방출, 평문과 완전 분리 → `?25l` 판별자 폐기**; ConPTY prelude 확정 + bare `ESC[25l` 노이즈 발견 + **ConPTY는 `?1049h`를 하위 전달 안 함**) → M0b Codex 게이트 APPROVE → M1 배치 shim PTY(`buildCmdLine` cross-spawn 이식 + node-pty 단일 문자열 args + 관통 적대 테스트) → M2 자동 PTY 라우팅(단일 비빌트인=interactive 기본, `!`=forceXterm 렌더 힌트로 분리) → M3 적응 렌더(`TuiSignalDetector` carry-buffer + `pty-render-upgrade` 프레임 + plain/xterm 이중 렌더 — plain도 즉시 ack(1MB 데드락 방지)·최소 키셋+paste 입력) → M4 파이프 stdin `['ignore','pipe','pipe']` → M5 가드(`guard:pty-routing`)+AC-1/2 자동화+패키징 스모크 8. **fix 루프 2회**: ① SSH 세션 xterm 승격 회귀(M5가 발견, ssh-session 업그레이드 선방출로 수정) ② verifier가 AC-4 git commit/push 공백 적발 → git-flow e2e+체크리스트 보완. 독립 verifier 최종 **PASS**(AC 10/10, 직접 재실행 검증). 수동 잔여: 실 claude/codex 인증 기동 — `docs/release/cli-parity-manual-checklist.md`. 베이스라인: **vitest 346 · e2e 58 · packaged 8 · audit 0**. 커밋 2c70bfe→2d56bbd→39debfa→33c2c7a.
- ✅ **터미널 느낌 회복 완료 (2026-07-03, 사용자 피드백 직후 증분):** "TUI가 터미널 안의 작은 창 같다" 피드백 → 화면 점유 문법 교정(아키텍처 불변, 렌더러 전용). **T1 TUI 페인 테이크오버**: xterm 승격 블록(claude/codex 자동, `!cmd`)이 실행 중 pane 전체 점유 — 형제 블록·cmd-input CSS 숨김(언마운트 금지, PTY 생존), 종료 시 피드 복귀+프롬프트 포커스, 인터프리터 사망 시에도 해제. **T2 인라인 프롬프트**: cmd-input 카드/폼 스타일 제거. **T3 크롬 다이어트**: 블록 여백 축소 + 어포던스 hover/focus-visible 노출 — 피드가 트랜스크립트로 읽힘. code-reviewer APPROVE(블로커 0, minor 2 반영: flake-proof 장수 픽스처, 세션사망 테이크오버 해제). 신규 `e2e/tui-takeover.spec.ts` 2건(결정적). 베이스라인: vitest 346 · e2e 59 · packaged 8 · audit 0. 커밋 8eacf37.
- ✅ **번들 ConPTY 채택 완료 (2026-07-03, 사용자 "스크롤 안 됨" 피드백 → 진단 2라운드):** `useConptyDll: true` — claude 대화 스크롤백 불가의 진짜 원인은 ink도 EZTerminal도 아닌 **Win10(19045) 시스템 ConPTY(2019년산)가 뷰포트를 지나간 내용을 하류로 전송하지 않는 결함**. 번들 conpty.dll(v1.23)로 전체 이력 휠 복구 실측 확인. 채택 과정에서 실측 발견·해결 2건: ① 신형 백엔드의 고정 프리앰블에 `?1004h`가 포함되어 모든 명령이 xterm 오승격 → 트리거 셋에서 1004 제외("백엔드 방출 시퀀스는 트리거 불가" 원칙, claude/codex는 ?2004h로 포착 유지), ② node-pty kill()의 useConptyDll 경로가 네이티브 kill 직전 입력 소켓을 동기 파괴(double-free 형태) → utilityProcess가 STATUS_HEAP_CORRUPTION(0xC0000374)으로 사망(cancel 1회에 동거 세션 전멸 위험) → Windows kill을 `taskkill /T /F` 외부 종료(검증된 자연 종료 teardown 경로) + 5s 폴백으로 라우팅. 부수 개선: 신형 백엔드는 `?1049h`(alt-screen)를 실제로 전달 — alt-screen TUI 감지가 이제 동작(e2e 기대치 갱신). 베이스라인: **vitest 349 · e2e 61 · packaged 8 · audit 0**. 커밋 66dbcb4 (+322ad80 회귀 잠금, 8eacf37 테이크오버).
- ⬜ **잔여:** B-M4 자동업데이트(**GitHub 저장소 결정 대기**) → E3 AI 보조(인터뷰+게이트, **데이터 이그레스 동의 대기**) → E6 크로스플랫폼. 사용자 결정은 `docs/NEXT-SESSION.md` 참조.

### ✅ 첫 수직 슬라이스 (완료 — load-bearing seam 증명)
`React 블록 → main 브로커 → utilityProcess 인터프리터 → async 행 파이프라인 → MessagePort 청크 → 가상화 테이블 → 취소`
- utilityProcess + MessageChannelMain 브로커링, ExecutionSession, credit 백프레셔 + ResultStore 윈도잉
- 수작업 lexer+Pratt 파서, Nushell식 값모델/PipelineData, Zod 명령 레지스트리, builtins `ls`/`where`/`sort-by`/`gen-rows`
- 블록 UI + TanStack Table/Virtual 가상화 (`gen-rows 100000` → DOM ~22행, 프리즈 없음)
- 외부 실행(cross-spawn, ANSI→HTML 새니타이즈, 트리 kill), 빌트인+외부 취소
- **검증:** typecheck 0 · vitest 97 · e2e 7 · **packaged smoke 1** · Phase-4 리뷰 3종(architect/security/code-reviewer) 전원 APPROVE (보안 HIGH 2건 수정·재검증 완료)

### 🔧 알려진 follow-up (비차단 — 다음 증분에서)
- ✅ **AC#4 히스토리(입력 ↑/↓ recall + `history` builtin) · `ps` builtin 완료 (AC#4-B)** — `ps`는 Windows-first(`tasklist`); 크로스플랫폼 프로세스 소스는 동일 seam(`createProcessLister`)에 후속 드롭인 — **ps 소스 크로스플랫폼화 완료(2026-07-03, 유닛 검증) — mac/linux 실검증은 하드웨어 확보 시**
- 프레임 어휘 편차: 구현은 `progress` 추가, `stderr`/`diagnostic` 생략(외부 stdout+stderr 병합) — 의도적, §3와 정렬 필요 시 문서화
- `url-guard.isAppUrl`가 모든 `file://` 허용 → 패키지 렌더러 경로로 범위 축소(하드닝; 현재 도달 싱크 없음)
- 파서 `parser.ts`의 dead `?? ` fallback 정리(Token 타입 조정 필요)
- dev-toolchain CVE(vitest/vite/esbuild/tar/tmp) — **prod 트리는 clean**, dev 의존성 별도 bump

상세 설계·리스크 레지스터는 `docs/design/shell-core-architecture.md` 참조.
