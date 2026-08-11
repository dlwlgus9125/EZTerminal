# 터미널 런타임 계약

> 문서 상태: **활성 규범 계약**
>
> 범위: 셸 세션, 구조화 파이프라인, 명령별 MessagePort, 외부 프로그램, PTY,
> SSH와 사용자 JavaScript 스크립트 실행.

## 현재 계약

터미널 런타임의 핵심 경계는 renderer와 Electron main이 아니라 별도 interpreter
`utilityProcess`다. Main의 `InterpreterBroker`는 interpreter 수명과 포트 전달만
소유하고, 파싱·상태 변경·실행·대용량 결과는 interpreter 안에 남긴다.

### 세션과 실행

- `ShellSession`은 sessionId별 cwd, env override와 variables를 명령 사이에 보존한다.
  전역 `process.chdir()`나 전역 환경 변경으로 세션을 구현하지 않는다.
- `ExecutionSession`은 runId별 파싱·평가·출력·취소·결과 정리를 소유한다.
- 한 셸 세션에는 foreground 실행을 하나만 허용한다. 다른 셸 세션의 실행은 서로
  독립적이다.
- `InterpreterBroker`만 세션 생성 상관관계, 실행·attach 포트와 interpreter 생존
  상태를 갱신한다. 로컬 IPC와 원격 bridge는 이 broker 위의 adapter다.
- interpreter가 죽으면 pending 생성·목록·attach를 명시적으로 실패시키고, 죽은
  프로세스에 전송한 요청을 성공으로 보고하지 않는다.

### 파서와 구조화 데이터

- hand-written lexer와 Pratt parser가 명령, pipeline, expression을 AST로 만든다.
  parser 경계 밖에서 문자열을 다시 명령으로 해석하지 않는다.
- `PipelineData`는 단일 값, lazy record stream, byte stream과 PTY/SSH/script 전용
  실행 종류를 판별 가능한 형태로 표현한다.
- `where` 같은 streaming 연산자는 `AsyncIterable`을 유지하고, `sort-by`처럼 전체
  입력이 필요한 연산자만 buffering한다.
- 명령 signature와 값 kind는 런타임 계약이다. Zod 검증을 모든 결과 행에 반복하지
  않는다.
- 사용자 입력은 command resolver와 argument builder를 거친다. Windows 실행 파일,
  PATHEXT와 `.cmd`/`.bat` 의미를 shell 문자열 결합으로 우회하지 않는다.

## 프레임과 배압

명령마다 main이 `MessageChannelMain`을 만들고 한 포트를 interpreter에, 다른 포트를
호출 표면에 전달한다. Main은 `start`, `schema`, `chunk`, `progress`, `pty-data` 같은
대량 프레임을 다시 직렬화하는 중계자가 아니다.

- 표 결과는 interpreter의 `ResultStore`에 보존하고 renderer가 `requestRows`로 필요한
  범위만 가져간다. 행 전체를 renderer state에 누적하지 않는다.
- plain text와 완료된 script 출력도 bounded frame과 retention 정책을 따른다.
- PTY와 SSH 출력은 `pty-data`로 xterm에 전달한다. interpreter는 누적 전송량과 누적
  ACK의 차이가 `PTY_HIGH_WATER`(1 MiB)를 넘으면 producer를 pause하고
  `PTY_LOW_WATER`(256 KiB) 이하에서 resume한다.
- Renderer는 xterm `write` callback이 끝난 바이트만 소비된 것으로 계산하고
  `PTY_ACK_QUANTUM`(64 KiB) 단위의 누적 ACK를 보낸다. 감소하거나 중복된 ACK는 상태를
  되돌리지 않는다.
- sink가 아직 없거나 render callback이 멈추면 producer는 bounded 상태에서 멈춘다.
  cancel·close는 ACK 흐름과 독립적으로 실행되어 사용자의 탈출구를 보장한다.
- PTY kill은 paused producer를 먼저 resume한 뒤 수행한다.

## 외부 프로그램과 PTY

### Windows 프로세스 소유권과 종료

Windows에서는 main이 interpreter나 창을 만들기 전에 native
`--process-guardian`을 시작한다. Guardian은 main을
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` root Job에 넣고, interpreter와 각
script-host에 별도 하위 Job을 부여한다. 이후 PTY·외부 명령·Codex·Claude가
만드는 자손은 실행 파일 이름과 무관하게 이 Job 트리를 상속한다.

정상 앱 종료는 새 broker 작업을 먼저 막고 interpreter에 전체 session drain을
요청한다. 각 execution의 취소와 process-tree 종료가 완료된 뒤 ACK하며, main은
남은 interpreter/script-host Job을 강제 종료한다. 동시에 guardian에 bounded root
deadline을 설정하므로 main이 종료 중 멈추거나 비정상 종료되어도 Job handle 소실로
모든 등록 자손이 정리된다. Renderer reload/crash나 창 재생성은 main 수명 종료가
아니므로 이 소유권을 끊지 않는다.

브라우저, 편집기, Explorer처럼 EZTerminal보다 오래 살아야 하는 사용자 앱은 root
Job 밖의 guardian이 `shell-handoff`로 연다. 반대로 시작 시 프로세스 이름을 검색해
과거 PID를 일괄 종료하지 않는다. 다른 EZTerminal 인스턴스나 사용자가 별도로 시작한
동명 CLI를 오인 종료하지 않기 위해, 현재 인스턴스가 등록한 Job만 정리 권한의
근거로 사용한다.

일반 외부 명령은 실행 특성에 따라 text 또는 PTY 경로를 선택한다. interactive CLI와
full-screen TUI는 `node-pty`/ConPTY와 xterm을 사용하며 입력·resize·cancel을 동일한
run port로 받는다. terminal renderer는 WebGL을 우선하되 DOM fallback을 유지한다.

Agents가 소유하는 Codex 새 세션과 재개 명령은 `--no-alt-screen`으로 inline TUI를
기동한다. 긴 대화 출력은 xterm normal buffer의 scrollback에 남아야 한다. 사용자가
terminal composer나 Command Center에서 직접 실행한 Codex/TUI 명령의 인자는 바꾸지
않으며, renderer가 DEC alternate-screen 제어 시퀀스를 전역으로 제거하지도 않는다.

로컬 PTY의 recent output ring과 headless terminal snapshot은 bounded다. late attach는
snapshot과 정확히 이어지는 tail을 먼저 적용한 후 live bytes를 연다. 연속성을 증명할
수 없으면 화면을 조용히 꾸미지 않고 `pty-restore-warning`과 bounded recent-output
fallback을 사용한다.

## SSH

- `ssh-connect`는 `ssh2` 기반의 전용 session runner를 사용한다. 로컬 `PtyHandle`을
  SSH 연결 이전부터 가장하지 않는다.
- known_hosts는 main이 소유하고 TOFU를 적용한다. 최초 지문은 사용자 확인을 받고,
  일치하지 않는 기존 키는 fail closed한다.
- SSH config alias와 명시적 `user@host`를 지원한다. private-key passphrase와 password는
  세션 프롬프트로만 받고 로그나 영속 저장에 남기지 않는다.
- 채널 생성 이후 출력은 PTY와 같은 누적 byte ACK 계약을 사용한다.
- loopback local forwarding은 main의 bounded TCP listener와 SSH 채널을 연결한다.
  전역·연결별·stream별 상한과 양방향 배압을 유지한다.
- SSH late attach는 완전한 terminal state를 증명할 수 없으므로 현재 거부하고
  `ssh-late-attach-unsupported`를 반환한다.

## JavaScript 스크립트

- `run-script <path> [args...]`는 `.js`와 `.mjs` 사용자 파일을 세션 cwd 기준으로
  해석한다.
- 스크립트마다 main이 별도 script-host `utilityProcess`를 생성하고 interpreter와
  전용 port를 연결한다. 격리 목적은 crash와 무한 루프 회수이며 보안 sandbox가 아니다.
- `ez.run()`은 현재 실행의 평가 context에서 직렬 실행되어 cwd/env/variables와 취소
  signal을 공유한다. nested `run-script`, SSH 세션과 forward 작업은 rows 반환 경로로
  허용하지 않는다.
- 한 `ez.run()`은 최대 100,000 rows를 반환한다. 초과하면 조용히 자르지 않고 해당
  호출을 실패시킨다.
- stdout/stderr 병합 출력은 8 MiB로 제한한다. plain-object 배열을 반환하면 표가 단일
  결과 shape가 되며 수집한 text는 표시하지 않는다. 배열을 반환하지 않으면 bounded
  text 결과를 표시한다.
- 완료, 오류, abort 또는 port 단절은 one-shot host를 정리한다.

## 실패와 변경 불변조건

- bulk output을 일반 `ipcMain.handle` 응답이나 React state로 옮기지 않는다.
- 새로운 frame/control은 [`ipc.ts`](../../src/shared/ipc.ts)의 판별 union에 먼저
  추가하고 interpreter와 renderer/mobile adapter를 함께 갱신한다.
- session 상태와 run 상태를 합치거나 전역 cwd로 대체하지 않는다.
- 보안 프롬프트, token, 명령 transcript를 진단 로그에 추가하지 않는다.
- 배압 상수를 변경할 때는 fake-port 단위 테스트와 실제 native PTY E2E를 함께
  검토한다.

## 근거 소스

- [`src/main/interpreter-broker.ts`](../../src/main/interpreter-broker.ts)
- [`src/interpreter/shell-session.ts`](../../src/interpreter/shell-session.ts)
- [`src/interpreter/interpreter-process.ts`](../../src/interpreter/interpreter-process.ts)
- [`src/interpreter/core/`](../../src/interpreter/core/)
- [`src/interpreter/pty-session.ts`](../../src/interpreter/pty-session.ts)
- [`src/interpreter/ssh-session.ts`](../../src/interpreter/ssh-session.ts)
- [`src/interpreter/script-runner.ts`](../../src/interpreter/script-runner.ts)
- [`src/shared/ipc.ts`](../../src/shared/ipc.ts)
- [`src/renderer/block-controller.ts`](../../src/renderer/block-controller.ts)

## 검증

- [`src/main/interpreter-broker.test.ts`](../../src/main/interpreter-broker.test.ts)
- [`src/interpreter/shell-session.test.ts`](../../src/interpreter/shell-session.test.ts)
- [`src/interpreter/pty-session.test.ts`](../../src/interpreter/pty-session.test.ts)
- [`src/interpreter/pty-session-attach.test.ts`](../../src/interpreter/pty-session-attach.test.ts)
- [`src/interpreter/ssh-session.test.ts`](../../src/interpreter/ssh-session.test.ts)
- [`src/interpreter/script-runner.test.ts`](../../src/interpreter/script-runner.test.ts)
- [`e2e/pty-backpressure.spec.ts`](../../e2e/pty-backpressure.spec.ts)
- [`e2e/adaptive-render.spec.ts`](../../e2e/adaptive-render.spec.ts)

과거 설계와 게이트 기록은
[`docs/archive/design/`](../archive/design/) 및
[`docs/archive/research/`](../archive/research/)에 있다.
