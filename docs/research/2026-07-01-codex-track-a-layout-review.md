# Codex 아키텍처 검증 — Track A Phase 1 (멀티세션 셸 백엔드 + dockview 탭)

> 2026-07-01. 코딩 전 게이트(M0). 대상: 승인된 plan `~/.claude/plans/ezterminal-vectorized-island.md`.
> 방식: Codex(codex-cli 0.142.0, gpt-5.5, reasoning xhigh) 적대적 read-only 아키텍처 리뷰(plan + 핵심 소스 8파일).
> 원본 아티팩트: `.omc/artifacts/ask/codex-adversarial-...-2026-07-01T02-53-08-699Z.md`.
> **Verdict: REVISE — 8 blocker.** 전부 plan 반영 후 M1 착수.

## Verdict 요약
**REVISE.** "한 utilityProcess + `Map<sessionId, ShellSession>`" 방향은 Phase 1에 **수용 가능**. 단 세션 수명·IPC 상관·동시성 설계를 코딩 전에 조여야 함.

## Blockers (해소 방법 = plan 반영)

1. **first-run lazy-create 금지 — `create-session`를 권위원으로.**
   현재 인터프리터는 `{type, commandText}`만 받고 항상 싱글턴 사용(`interpreter-process.ts:161,168`). destroy 후 lazy-create는 **좀비 세션 부활** 가능.
   → `create-session`가 세션을 만드는 유일 경로. **unknown/destroyed/destroying `sessionId`의 `run`은 생성이 아니라 거부(에러 프레임).**

2. **destroy는 map 삭제가 아니라 열린 실행을 소유해야.**
   `ExecutionSession`은 `ShellSession` 참조 보유(`interpreter-process.ts:55`), 완료 블록도 페이징 위해 포트/스토어 유지.
   → 인터프리터에 `SessionRecord = { shell, state, executions:Set }`. `destroy-session`는 **idempotent**, `destroying` 마크, 열린 command session 전부 abort/dispose + 포트 close, 그 후 record 제거.

3. **포트 상관(runId)을 preload가 아니라 그 앞(main)에서.**
   main은 `cmd-port`를 runId 없이 전송(`main.ts:85/95`), preload는 run마다 `ipcRenderer.once('cmd-port')`(`preload.ts:27/30`). **동시 run이 포트를 오상관** 가능(App의 `_ezPort===runId` 필터 이전 단계에서). 오늘은 잠재버그, 탭 동시성에서 발현.
   → `run-command`에 `runId`(+`sessionId`) 전달; main이 `cmd-port`에 `{runId}` 동봉; preload는 pending map/per-run 채널로 매칭 포트만 전달.

4. **동일 세션 foreground run 직렬화(또는 스냅샷 의미 정의).**
   `createContext()`가 live cwd/env getter(`shell-session.ts:71`), `let`/env 할당은 동기 변이(`evaluate.ts:196`), 스트리밍 `where`가 반복 중 변수 읽음(`builtins.ts:101`). 한 세션 병렬 run은 **mid-stream 상태 변화**를 관측.
   → Phase 1은 **세션/패널당 foreground run 큐 1개**. 병렬성은 세션(탭) 간에만.

5. **전역 initial cwd → create-session 결과로.**
   `get-initial-cwd`는 main의 process.cwd()(`main.ts:102`). 새 세션은 자기 authoritative cwd 필요.
   → `createSession(cwd?) -> { sessionId, cwd }`, 인터프리터가 `ShellSession(cwd)` 생성 후 resolve. **resolve 전까지 패널 입력 비활성.**

6. **탭 close 정리 순서 정의.**
   렌더러 dispose는 `close` 전송+포트 close(`block-controller.ts:132`), 인터프리터 close는 PTY/store 해제(`interpreter-process.ts:75,114`).
   → 탭 close 시 **패널 closing 마크 → 모든 controller dispose → `destroy-session`** 순서. 렌더러 정리가 스킵돼도 **백엔드 destroy만으로 충분**해야.

7. **xterm 명시적 visibility refit 추가.**
   dockview `renderer:'always'`는 인스턴스 유지 + 비활성 패널을 `visibility:hidden`으로 숨김. 현재 `PtyBlock`은 `ResizeObserver`에만 의존(`PtyBlock.tsx:56`).
   → dockview 패널 `onDidVisibilityChange`/dimension 변화를 xterm refit(rAF)으로 연결. **zero/측정불가 박스에서는 pty-resize 전송 억제.**

8. **한 utilityProcess의 shared-fate 정책 명시.**
   main은 utility exit를 로그+핸들 null만(`main.ts:134`). 한 세션의 crash/native fault가 **전 세션 다운**.
   → Phase 1 수용 가능하되 **명시적으로**: 렌더러 통지 → 전 패널 dead 마크 → main 세션 레지스트리 clear → respawn/새 세션 전까지 run 거부.

## 비차단 노트 (반영/추적)
- **`sessionId`를 `InterpreterFrame`에 추가하지 말 것.** MessagePort가 이미 프레임↔run 상관. `sessionId`는 lifecycle + `run` IPC에만.
- **main이 `sessionId` 생성**(가능하면). 렌더러 발급 ID는 권한 경계는 아니나 main/interpreter가 shape/length/uniqueness/live-state 검증해야. → 채택: **create-session 왕복에서 main/interpreter가 sessionId 발급**.
- dockview CSP는 Phase 1 호환(문서상 eval/Function/inline handler/CSS-in-JS runtime 없음). `dockview.css`를 Vite로 import + **패키지 스모크 유지**.
- Phase 1이 탭 전용이면 dockview **`disableDnd`/locked** 설정(분할/드래그는 후속 Phase).

## plan 반영 매핑
- M1(백엔드): B1(authoritative create) · B2(SessionRecord+destroy) · B3(runId 상관) · B4(세션당 run 큐, 백엔드측) · B5(createSession→{sessionId,cwd}) · B8(shared-fate) · 비차단(main 발급/검증, frame에 sessionId 미추가).
- M2(렌더러 리프트): B4(패널이 foreground run 직렬화·입력 게이팅) · B5(create 전 입력 비활성) · B6(close 정리 순서 훅 준비).
- M3(dockview): B6(탭 close 순서) · B7(visibility refit) · 비차단(disableDnd, dockview.css via Vite).
- M4(패키지): 비차단(CSP 패키지 스모크).

## 결론
8 blocker 전부 plan 반영(아래 plan §"M0 반영") → **M1 착수 가능.**
