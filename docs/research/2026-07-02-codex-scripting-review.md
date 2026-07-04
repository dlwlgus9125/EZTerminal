# Codex Gate — Stage E4 JS 스크립팅 (E4-M0)

> Date: 2026-07-02 · Input: `docs/design/scripting-design.md` (draft, 875d4de)
> Runner: codex-companion (rollout 2026-07-02T21-16-07) · **Verdict: REVISE — 4 blockers.**
> 방향(메인 브로커드 script-host utilityProcess + 인라인 evaluate)은 타당 — 수명주기/취소/
> 직렬화/상한 강제가 미명세. 전부 설계에 폴드 완료(→ Resolution).

## Blockers

**B1. script-host 수명·kill 레지스트리 부재.** UtilityProcess 핸들과 `.kill()`은 main만 보유
(`electron.d.ts:15725-`); 현 IPC엔 spawn/kill/exit 프로토콜 없음.
→ **Resolution: main에 `ScriptHostRegistry`** — hostId 상관, `spawn-script-host`/`kill-script-host`
(interp→main), `script-host-ready`(+포트 transfer)/`script-host-error`/`script-host-exit`(main→interp).
teardown 경로 전수: done/error/abort/포트 close/utility exit/스폰 실패/interpreter 사망(전체 kill).

**B2. 취소가 호스트 RPC await를 못 깨움.** `ExecutionSession.abort()`는 ac.abort()만;
`script-done`/`ez-run-result` 대기 promise는 영원히 pending 가능.
→ **Resolution: 모든 대기를 race(ctx.signal, host-exit, port-close)** — abort 시 pending 전부
reject + main에 kill-by-id + cancelled 방출.

**B3. 병렬 `ez.run()` = 세션 상태 오염.** ShellSession은 단일 가변 상태(live cwd/env getter);
기존 foreground 게이트가 막던 레이스를 인라인 evaluate가 우회(예: `ls`가 iteration 중 cwd 읽는
동안 병렬 `cd`가 setCwd).
→ **Resolution: 실행당 in-flight sub-evaluate 1개** — 인터프리터 RPC 핸들러가 evaluate 호출 전
직렬 큐 강제(동시 요청은 순차 처리).

**B4. 상한이 정책 선언뿐.** 100k rows/8MB 텍스트가 "체크 시점" 미명세.
→ **Resolution: 증분 카운터** — rows: 100,001번째 push 전에 중단(해당 ez-run만 에러 회신);
stdout/stderr 합산 8MB 초과 append 전에 중단 → **host kill + 하드 에러 프레임**. 전량
materialize 전에 강제.

## 게이트 질문 답변 (설계 확정)

① **rows+stdout:** 블록=단일 shape(SchemaFrame/Block.tsx 구조 확인) → v1: rows 반환 시
stdout **폐기 + 문서화**.
② **stdout 중계:** utilityProcess 기본 stdio는 inherit이고 main이 stdout을 읽으려면 pipe 필요
→ **host에서 `process.stdout.write`와 `process.stderr.write` 둘 다 패치**해 `script-print`
프레임으로 포트 직송(외부 명령의 stdout+stderr 병합 규칙과 정렬; stdio는 inherit 유지).
③ **직렬 큐:** 선택이 아니라 **필수** (B3).
④ **worker_threads 대안:** 프로세스/메모리 공유 — OS-kill/크래시 격리 목표 불충족 → 기각 유지.
⑤ **상한값:** v1 하드캡으로 타당하되 증분 강제 필수 (B4). 스트리밍 아님이 전제.

## 추가 발견

- 인라인 evaluate 기계적 실현성 CONFIRMED: 핸들러는 (input, invocation, ctx)만 받고
  `parse/evaluate` 재사용 가능 (`core/index.ts:74-82`).
- **v1 제약(문서화 필수): 사용자 스크립트의 bare import는 스크립트 파일 위치 기준
  node_modules 탐색** — 앱이 패키지를 제공하지 않음. `pathToFileURL` + Node ESM 규칙.
- 4번째 Vite 엔트리 필요; 순수 JS 호스트라 asar.unpack 불요; `path.join(__dirname,
  'script-host.js')` 해석은 interpreter-process 선례와 동일. packaged 스모크는
  packaged-smoke.spec.ts 패턴 복제.

## C1–C5 감사
C1(RunAsNode:false→fork 불가) CONFIRMED · C2(utilityProcess=main 전용+브로커 선례) CONFIRMED ·
C3 PARTIALLY(인라인 가능하나 B2/B3 필요) · C4(신뢰 모델) CONFIRMED · C5 CONFIRMED+제약(bare import).
