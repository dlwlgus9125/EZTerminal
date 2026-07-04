# EZTerminal — 셸 코어 아키텍처 (Phase 1)

> 상태: **LOCKED (2026-06-29)** — deep-research 2회 + Codex 적대적 아키텍처 검증 반영.
> 근거 문서: `docs/research/2026-06-29-tech-research.md`, `docs/research/2026-06-29-interpreter-research.md`.

## 핵심 통찰 (Codex 검증)
load-bearing 리스크는 파서/타입이 아니라 **Electron 프로세스 경계를 넘는 스트리밍 실행**이다.
**프로세스/스트리밍/취소 seam을 가장 먼저 설계·검증한다.** IPC는 "결과를 React로 보낸다"가 아니라 **프레임 단위 + 백프레셔 프로토콜**로 다룬다.

---

## 1. 프로세스 토폴로지
- **Renderer (React):** UI 전용. 블록 입력 + 가상화 출력. 인터프리터 로직 없음.
- **Main:** 브로커. utilityProcess 생성/소유, MessagePort 중개, 수명 관리.
- **utilityProcess (Node):** 인터프리터/실행기. parse → eval → stream.
  - main-process 실행은 앱을 얼릴 수 있어 임시 스파이크용으로만.
  - worker_thread는 CPU-bound JS용 — 우리 작업은 process/fs/IPC I/O-bound라 부적합.

## 2. 핵심 모듈 — `ShellSession` (durable) + `ExecutionSession` (per-command)
- **`ShellSession` (영속, utilityProcess당 1개):** cwd / env 오버라이드 / variables(`Map`)를 **명령 실행 간 보존**한다. `cd`는 이 cwd를 변경(전역 `process.chdir` 아님), `$env.X = …`는 env 오버라이드(read 시 `process.env` 위에 머지), `let x = …`는 variables에 기록. 한 Block이 설정한 상태는 다음 Block에서 보인다.
- **`ExecutionSession` (명령당 1개):** parse/eval 수명, 출력 프레이밍, 취소(AbortController), 외부 프로세스 정리, 결과 페이징. cwd/env는 더 이상 자체 스냅샷이 아니라 **`ShellSession` 위에서** `EvalContext`로 라이브 조회한다(`createContext`의 `cwd`/`env` getter). 즉 ExecutionSession은 ShellSession 위의 per-command 실행이다.
- `run(commandText)` → 블록별 실행 생성 + 전용 MessagePort.
- `abort()` → 취소 단일 진입점:
  - 빌트인은 청크 사이에 `signal.throwIfAborted()`
  - 외부 `spawn(..., { signal })`
  - 스트림 `stream.addAbortSignal(signal, …)`
  - async iterable은 `return()`/`finally`로 정리
  - 종료 프레임 후 IPC 포트 close

## 3. IPC 프로토콜 (명령 블록 단위)
- Renderer → Main: `run(commandText)`. Main이 블록별 전용 **MessagePort**(MessageChannelMain/MessagePortMain) 전송 → renderer엔 DOM `MessagePort`로 도착.
- utilityProcess → Renderer (프레임): `start`, `schema`, `chunk`(배치 행/텍스트), `stderr`, `diagnostic`, `end`, `error`, `cancelled`.
- Renderer → utilityProcess (제어): `cancel`, `pause`, `resume`, `requestRows`, `setViewport`.
- **백프레셔(앱 레벨 credit):** renderer가 N행/M바이트 grant → 인터프리터는 credit 초과 전송 금지. **행마다 메시지 금지, 배치 청크.**
- **ResultStore:** 큰 결과는 block id 키로 보관(utility/main 측), renderer는 윈도우 페이지만 렌더. **100k행 React state 저장 금지.**
- 일반 IPC는 structured clone이라 큰 결과 즉시 전송은 잘못된 인터페이스.

> **Addendum (2026-07-02, 구현 어휘 정렬 — 원문 LOCKED 유지):** 실제 구현(`src/shared/ipc.ts`)은
> 위 어휘에서 다음이 다르며 전부 **의도적**이다.
> - 프레임 **추가:** `progress {count,done}` (행 자체 없이 러닝 카운트/완료 — 가상화 테이블 높이용),
>   `pty-data` (Phase 2 TUI — ResultStore/credit 우회, xterm 직행).
> - 프레임 **생략:** `stderr`·`diagnostic` — 외부 프로그램은 stdout+stderr를 **병합** 스트림으로
>   캡처하므로(§7 ProcessRunner) 별도 프레임이 불필요. 분리 필요성이 생기면 additive로 재도입.
> - 제어 **생략:** `pause`/`resume` — credit 윈도우(`requestRows`/`setViewport`가 grant 역할)가
>   동일 목적을 수행. 제어 **추가:** `close`(블록 dispose → 스토어 해제), `pty-input`/`pty-resize`(Phase 2).

## 4. 값 & 파이프라인 모델
- **`PipelineData` = 판별형(discriminated) 런타임 객체** (느슨한 union 금지). kind + 메타데이터 + cleanup + 취소 훅 보유. kind:
  - `Value` — materialized 단일 값
  - `ListStream` — `AsyncIterable<RecordValue>` (lazy 구조화 행)
  - `ByteStream` — Node `Readable`에서 어댑트한 `AsyncIterable<Uint8Array>` (외부/IO/텍스트)
- **스트리밍 코어 = AsyncIterable.** Node 스트림은 바이트/프로세스 가장자리만 (async iteration·highWaterMark 백프레셔·addAbortSignal 지원).
- **연산자 trait:** 각 빌트인이 streaming/buffering 선언. `where`/`each`=스트림, `sort-by`/`group-by`=버퍼링(materialize). 수락 예시 `... | sort-by name`은 where 이후 materialization 필요. **연산자별 명시.**

## 5. 타입 시스템 (Phase 1 최소)
- 값 kind: `null`,`bool`,`number`,`string`,`filesize`,(`datetime`),`record`,`table`(=record stream/list),`bytes/text stream`.
- 명령 시그니처: name, 위치 인자, 플래그(--long/-short, boolean 스위치), 수락 input kind, output kind. 컬럼 메타데이터는 선택(첫 행들에서 추론).
- **Zod는 명령 정의 + 인자 검증에만.** 파이프라인 행마다 Zod 검증 금지.
- `size > 100mb`엔 타입 리터럴 + 런타임 비교 가능 값 필요. 전역 타입 추론·제네릭 스키마 불필요.

## 6. 파서 (확정 보류 — 인터페이스 뒤)
- Phase-1 문법(`cmd arg --flag | cmd2 expr`)은 작음 → **수작업 lexer + Pratt 파서**로 시작, `Parser` 인터페이스 뒤에.
- **Chevrotain은 나중에 채택**하되, {파스 에러 + 구문 강조 + 구문 자동완성}의 단일 문법 소스가 될 때 그 깊이가 값을 함 (Codex 결정 규칙). Chevrotain content-assist는 *구문만*(~10배 느림, 그 모드에선 에러복구 없음) → 의미 완성(명령명·경로·컬럼·플래그)은 어차피 별도 레이어.
- **스트리밍 seam 검증 전에 문법에 과투자 금지.**

## 7. 외부 프로그램 실행 (Windows 1급)
- `CommandResolver`: PATHEXT, .cmd/.bat 해석, 쿼팅, 세션 cwd/env.
- `ProcessRunner`: `spawn(..., { signal })`로 취소; stdout/stderr를 ByteStream으로 스트림; .bat/.cmd는 `cmd.exe /c`(직접 execFile 불가); ANSI SGR → HTML(ansi_up, 렌더 전 escape/sanitize).
- **Phase-1 비대화형:** git status·node --version OK. git commit·비밀번호 프롬프트·pager·풀스크린 TUI ✗ (node-pty 없음).
- **Adapter 뒤에 둬서** 2차에 child_process → node-pty 교체.

---

## 8. 🎯 첫 수직 슬라이스 (가장 먼저 — 진짜 load-bearing seam 증명)
경로: **React 블록 → main 브로커 → utilityProcess 인터프리터 → async 행 파이프라인 → MessagePort 청크 → 가상화 테이블 → 취소**

포함:
1. `ls | where size > 100mb | sort-by name` (ls→table, where→스트림 필터, sort-by→버퍼링)
2. **가짜 대량 행 소스**(예: `gen-rows 100000`)로 백프레셔 + 테이블 가상화 증명
3. `node --version`(또는 `git --version`) 스트림 텍스트 블록
4. **취소**: 빌트인 스트림 + 외부 프로세스 둘 다
5. **패키지 Windows exe 스모크 테스트**(utility process 포함)

문법/타입 완성부터 시작하지 말 것. **프로세스/스트리밍/취소 seam을 먼저 증명.**

---

## 9. 리스크 레지스터 (Codex, 심각도)
- **P0** IPC/결과 스트리밍 미정의 → `ExecutionSession` + `ResultStore` + 프레임 MessagePort + credit/백프레셔
- **P0** 인터프리터 main 배치 시 앱 프리즈 → utilityProcess, main=브로커
- **P0** Windows 외부 실행 의미 → `CommandResolver` + `ProcessRunner` 지금 구축(.cmd/.bat·PATHEXT·cwd/env·취소)
- **P1** 스트리밍 과약속 → 연산자 streaming/buffering trait (`sort-by`는 collect)
- **P1** Chevrotain 자동완성 = 구문만 (의미 완성 별도)
- **P1** 타입시스템 비대 → 런타임 명령 시그니처 + 기본 kind만
- **P2** 향후 PTY 재작성 → 외부 실행 Adapter 뒤에
