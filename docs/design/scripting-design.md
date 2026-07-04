# Stage E4 — JS 스크립팅 (Design, E4)

> Status: **GATED — Codex REVISE(4 blockers) folded (2026-07-02). Ready for build.**
> Gate record: `docs/research/2026-07-02-codex-scripting-review.md`
> Date: 2026-07-02 · Baseline: 2767afe (vitest 228 · e2e 35 · packaged 5)
> Vision fit: 새 언어 발명 금지(ROADMAP) → **JS 임베드(zx/bun 계열)**. 구조화 셸 위에서
> 스크립트가 파이프라인을 실행하고 rows를 JS로 가공해 다시 표로 내놓는 것이 차별점.

## 0. Hard constraints (verified)

| # | Fact | Consequence |
|---|------|-------------|
| C1 | fuses `RunAsNode:false` (forge.config.ts) → 패키지드 exe를 `ELECTRON_RUN_AS_NODE`로 재기동 불가 | **인터프리터(utilityProcess)가 `child_process.fork`로 JS 스크립트 호스트를 못 띄움.** 스크립트 호스트는 main의 `utilityProcess.fork`로만 가능 |
| C2 | `utilityProcess.fork`는 main 전용 API | 스크립트 호스트 스폰은 **브로커 패턴**(기존 cmd-port와 동형): interpreter → main(요청) → main이 fork + `MessageChannelMain` 포트쌍으로 script-host ↔ interpreter 직결 |
| C3 | 세션당 foreground run 직렬화(Track A M1) — `run-script` 실행 중 세션은 BUSY | 스크립트의 `ez.run()`은 **중첩 세션 run이 아니라**, 현재 실행의 `EvalContext` 안에서 **인라인 `evaluate(parse(cmd), ctx)`** — 데드락 없음, 취소 signal 상속, cwd/env/vars 라이브 공유 |
| C4 | `node:vm`은 보안 경계 아님(플랜) — 단, 위협 모델상 스크립트는 **사용자 자신의 코드**(.bashrc급 신뢰) | 프로세스 격리의 목적은 보안이 아니라 **크래시 격리 + 확실한 kill**(무한루프 스크립트가 인터프리터를 못 죽임) |
| C5 | Forge Vite는 엔트리별 별도 CJS 번들 (interpreter-process 선례) | `src/script-host/script-host.ts` = 4번째 빌드 엔트리 (`vite.script-host.config.ts`, forge.config.ts build[]에 추가). packaged e2e로 asar-fork 검증 필수 (packaged-smoke 선례) |

## 1. UX (v1 범위 — 최소)

- 빌트인 `run-script <path> [args...]` — path는 세션 cwd 기준 상대/절대. `.js`/`.mjs`만 (v1).
- 스크립트 전역 `ez`:
  - `await ez.run('ls | where size > 1mb')` → `{ rows: object[] }` (구조화 파이프라인 결과를
    배열로 collect; **상한 100k rows** — 초과 시 에러로 명시 거부, 조용한 절단 금지)
  - `ez.args: string[]` · `ez.cwd: string` (시작 시점 스냅샷)
- **출력 형태 (v1 규칙):** 스크립트 모듈의 default export(함수면 호출·await한 결과값)가
  - plain object 배열 → **표 블록** (기존 ListStream 경로)
  - 그 외/없음 → **텍스트 블록** = 스크립트의 stdout(+stderr 병합, 외부 명령과 동일 규칙)
  - 배열 반환 시에도 stdout은 유실하지 않고 텍스트로 앞에 붙일지 → **게이트 질문 ①**
    (v1 제안: rows 반환이면 stdout은 무시하되 문서화 — 블록은 단일 shape)
- 취소: 기존 AbortController → interpreter가 main에 kill 요청(또는 포트 close가 곧 종료 신호).
  스크립트는 어느 시점이든 죽을 수 있음(사용자 자신의 코드 — 정리 보장 없음).

### 구현 노트 (빌드 완료, 2026-07-02)

- **사용법:** `run-script <path> [args...]` — `path`는 세션 cwd 기준으로 해석되고
  `.js`/`.mjs`만 허용(그 외 확장자는 evaluate 시점에 즉시 에러). `args`는 그대로
  문자열 배열로 스크립트의 `ez.args`에 전달된다(`cd`처럼 bare word/문자열/`$var`/
  `$env.X`를 리터럴로 해석 — evalExpression이 아니라 `cdPathArg`와 동일한 경로).
- **rows 반환 시 stdout 폐기(문서화, 게이트 질문 ① 확정):** 스크립트가 plain-object
  배열을 반환하면 그 배열이 표 블록이 되고, 실행 중 쓴 stdout/stderr는 폐기된다
  (블록은 항상 단일 shape). 텍스트를 보고 싶다면 배열을 반환하지 말 것.
- **bare import는 스크립트 파일 위치 기준(사용자 node_modules) — 앱이 패키지를 제공하지
  않음.** script-host는 `pathToFileURL(scriptPath)`로 실제 파일시스템 경로를
  동적 import하므로(asar 밖), Node의 표준 ESM/CJS 해석 규칙에 따라 스크립트가 있는
  디렉터리 트리를 기준으로 `node_modules`를 찾는다.
- 구현: `src/script-host/script-host.ts`(호스트) · `src/interpreter/script-runner.ts`
  (호스트 브로커링/직렬화/상한 강제) · `src/main/script-host-registry.ts`(main의
  fork/kill 레지스트리). `run-script`는 `src/interpreter/core/builtins.ts`에 등록된
  일반 빌트인으로, `ScriptStreamData`(신규 PipelineData variant)를 반환하고
  `ExecutionSession`이 `pty-stream`과 동일한 방식으로 `runScriptSession`에 라우팅한다.

## 2. Process/protocol topology

```
renderer ──(기존 cmd-port)── interpreter(utilityProcess)
                                │  'spawn-script-host' (요청: 없음→main)     ┐
main ── utilityProcess.fork ──> script-host(utilityProcess, 스크립트당 1개)  │ C1/C2
                                │<── MessageChannelMain 포트쌍 ──>│          ┘
interpreter ↔ script-host RPC (포트 직결, main 미경유):
  host→interp: { type:'ez-run', id, command }        // C3: 인라인 evaluate
  interp→host: { type:'ez-run-result', id, rows | error }
  host→interp: { type:'script-done', value } | { type:'script-error', message }
  host stdout/stderr: utilityProcess stdio 'pipe' → main이 수집? ✗ — 게이트 질문 ②:
    stdout은 main 경유(스폰 소유자)라 interpreter로 재중계 필요.
    제안: host가 stdout을 가로채(process.stdout.write 패치) 포트로 'script-print' 프레임 전송
    → main 미경유, 기존 "벌크는 포트 직결" 원칙 유지.
```

- run-script 빌트인(인터프리터): ByteStream(텍스트) 또는 collect-후-ListStream(rows) 반환 —
  기존 block-runner가 그대로 렌더. **rows 스트리밍은 v1 비목표**(스크립트 완료 후 일괄).
- script-host 수명: run 1회 = host 1개. done/error/abort/포트단절 → main이 kill. 좀비 방지:
  interpreter 사망 시(포트 close) host 자동 종료 + main의 host 레지스트리(shared-fate 확장).
- 스크립트 로딩: host가 `await import(pathToFileURL(scriptPath))` — 사용자 파일시스템의
  실제 파일 (asar 밖). ESM/CJS 판별은 Node 기본 규칙.

## 3. Touch points

```
src/script-host/script-host.ts     (new) 호스트: ez 전역 구성, import, RPC, stdout 패치
vite.script-host.config.ts         (new) + forge.config.ts build[] 항목
src/shared/ipc.ts                  ScriptHost RPC 타입 + MainToInterpreter/InterpreterToMain 확장
src/main/main.ts                   'spawn-script-host' 브로커 + host 레지스트리/shared-fate
src/interpreter/script-runner.ts   (new) run-script 빌트인 구현부(RPC 클라이언트, collect, 상한)
src/interpreter/core/builtins.ts   run-script 등록 (registry 패턴)
e2e/scripting.spec.ts              rows 반환→표 · 텍스트 · ez.run 파이프라인 · 취소 · 에러
e2e-packaged                       packaged에서 script-host asar-fork 스모크 1개 (C5)
```

## 4. Risks

| Risk | Mitigation |
|---|---|
| 무한 stdout 스크립트 (제2의 firehose) | 'script-print' 프레임도 pty-ack와 동일한 상한 필요? → v1: 텍스트 collect에 **총량 상한(8MB)** 후 에러 종료 (스트리밍 아님 — 단순) — 게이트 검증 |
| ez.run이 PTY(`!cmd`)를 요구 | v1 거부(에러) — 스크립트 안 인터랙티브는 무의미 |
| ez.run 결과 collect가 인터프리터 메모리 폭발 | 100k rows 상한 + row당 JSON 직렬화 비용은 기존 chunk 경로와 동일 |
| host 스폰 실패(패키지드 경로) | packaged e2e 필수(C5); 실패 시 명확한 에러 프레임 |
| 스크립트가 ez.run을 병렬 다발 호출 | RPC id 상관 + 인터프리터는 순차 처리(단일 ctx — 동시 evaluate는 세션 상태 레이스) → 직렬 큐, 게이트 확인 |

## 5. Out of scope (v1)

인라인 `js {...}` 문법 · TS 트랜스파일 · rows 스트리밍 반환 · 스크립트 간 import 관리 ·
샌드박스/권한 프롬프트(신뢰 모델 C4) · watch 모드.

## 6. 게이트 반영 (REVISE 4블로커 — 빌드 요구사항)

1. **ScriptHostRegistry (main, B1):** `Map<hostId, UtilityProcess>`. 프로토콜(additive):
   interp→main `spawn-script-host {hostId}` / `kill-script-host {hostId}`;
   main→interp `script-host-ready {hostId}`(+MessageChannelMain 포트 transfer) /
   `script-host-error {hostId, message}` / `script-host-exit {hostId, code}`.
   teardown 전수: done/error/abort/포트 close/host exit/스폰 실패 + **interpreter 사망 시 전체 kill**.
2. **취소 (B2):** script-runner의 모든 대기는 `race(ctx.signal, host-exit, port-close)`.
   abort → pending 전부 reject → `kill-script-host` → cancelled 방출.
3. **ez.run 직렬화 (B3, 필수):** 실행당 in-flight sub-evaluate 정확히 1 — RPC 핸들러가
   evaluate 호출 전 직렬 큐로 강제.
4. **상한 증분 강제 (B4):** rows는 100,001번째 push 전 중단(해당 ez-run 에러 회신);
   stdout+stderr 합산 8MB 초과 append 전 중단 → host kill + 하드 에러.
5. **확정 답:** rows 반환 시 stdout 폐기(문서화) · host에서 stdout **및 stderr** write 패치 →
   `script-print` 포트 직송(stdio inherit 유지) · worker_threads 기각 ·
   **bare import는 스크립트 위치 기준 해석(사용자 node_modules) — 문서화 필수.**
