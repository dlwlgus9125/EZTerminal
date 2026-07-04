# Codex Gate — Stage C PTY Firehose Backpressure (C-M1)

> Date: 2026-07-02 · Input: `docs/design/pty-backpressure-design.md` (pre-gate draft, commit 7d559ec)
> Runner: codex-companion task (rollout 2026-07-02T16-40-01, 6.4분, read-only)
> **Verdict: REVISE — 4 blockers.** Direction B(pause/resume)는 타당하나, Windows 배압 경로
> 과대주장 + 렌더러측 무한 버퍼 누락 + 무ack 프로토콜의 상한 미증명 + 패키지드 갭.
> 아래 Resolution대로 설계 개정 후 C-M2 진행.

## Blockers

**B1. F1이 Windows ConPTY pause 경로를 과대주장.** `Terminal.pause()`는 앱측
`_agent.outSocket`을 멈추지만(`terminal.js:122-128`, `windowsTerminal.js:51-52`),
ConPTY 출력은 먼저 **워커 스레드**가 `conoutSocket.pipe(workerSocket)`으로 배수하고
(`worker/conoutSocketWorker.js:12-14`) 앱 소켓은 워커 파이프에 연결됨
(`windowsConoutConnection.js:100-101`). 즉 배압은 {워커 파이프 버퍼 + 앱 소켓 버퍼}
두 유한 버퍼를 통해 전파 — 즉시 정지가 아니라 "유한 상수 뒤 정지".
→ **Resolution: F1 개정(워커 홉 명시) + dev/packaged 양쪽에서 pause 후 성장 정지를 실측.**

**B2. 렌더러 백로그 계측 위치가 너무 늦음 — 기존 무한 버퍼 누락.** 초안은 PtyBlock의
`term.write()` 대기 바이트만 추적하나, `BlockController`는 포트를 즉시 start하고 sink
등록 전 `pty-data`를 **무한 버퍼링**(`block-controller.ts:72-73,125-131,189-191`);
PtyBlock은 schema 후에야 마운트(`Block.tsx:88-100`).
→ **Resolution: 계측을 BlockController로 이동 — pre-sink 버퍼 포함. ack는 xterm flush
시점에만 발생하므로 pre-mount 구간은 인터프리터가 HIGH에서 pause → 구성적으로 유계.**

**B3. boolean `pty-flow`는 ack/epoch가 없어 큐 상한을 증명 불가.** 로컬 term.write
콜백 기준 XON은 포트 대기 중인 구프레임을 못 세어 overshoot/재pause 가능.
→ **Resolution: 프로토콜 교체 — 행 credit과 동형인 바이트-ack. 렌더러→인터프리터
`pty-ack {bytes: 누적 소비량}`(64KiB 양자마다), 인터프리터가 `sent - acked > HIGH(1MiB)`면
pause / `≤ LOW(256KiB)`면 resume. pause 결정이 sent 카운터가 있는 쪽(인터프리터)에서
일어나므로 in-flight 총량 ≤ HIGH + 1청크가 구성적으로 보장.**

**B4. 패키지드 검증 갭 수용 불가 — 싼 경로가 이미 존재.** `pty-packaged.spec.ts`가
UI 없이 패키지드 node-pty로 실 PTY를 스폰함(`:35-68`).
→ **Resolution: 해당 스펙 확장 — firehose 자식 → `proc.pause()` → 데이터 성장 정지
단언 → paused 상태에서 kill → `onExit` 시한 내 발화 단언. B1의 워커-홉 실측과
paused-kill 엣지를 실제 native 스택에서 증명.**

## 게이트 질문 답변

1. **ConPTY exit 경로:** 네이티브 exit 신호는 별도로 도착해 `_exitCode` 저장 후 cleanup이
   `_outSocket`을 destroy(`windowsPtyAgent.js:221-245`) — 그러나 공개 `onExit`은
   `_socket.on('close')`에서만 발화(`windowsTerminal.js:96-99`). destroy는 paused와
   무관하게 'close'를 발화시키므로 paused-kill이 onExit을 영구 차단하진 않음.
   또한 앱의 취소 응답성은 onExit에 의존하지 않음 — `PtySession.onAbort`가 kill 직후
   즉시 `cancelled`를 방출(`pty-session.ts:62-71`). resume-then-kill은 유지(방어적)하되
   exit 검출의 필요조건은 아님.
2. **패키지드 갭:** 수용 불가 → B4 Resolution으로 해소.

## 적대적 발견 (shared-port XON/XOFF)

- 순서/지연: 무ack boolean의 overshoot — B3 Resolution(ack 프로토콜)로 해소.
- 영구 pause 창: ① pre-sink 버퍼(B2 Resolution로 유계화) ② term.write 콜백 미발화 —
  잔존하나 cancel 경로가 flow와 독립(즉시 cancelled)이므로 사용자 탈출구 보장.
- 입력은 paused와 무관: 입력은 별도 `inSocket`(`windowsPtyAgent.js:81-87`) — paused 중
  타이핑/Ctrl+C가 child에 도달함을 확인 (설계 유지).

## F1–F4 감사

| # | Status | Resolution |
|---|--------|-----------|
| F1 | PARTIALLY | 워커 홉 명시로 개정, 실측으로 보강 (B1) |
| F2 | CONFIRMED | handleFlowControl=같은 pause+입력 하이재킹 (`terminal.js:75-88`) |
| F3 | PARTIALLY | F1 개정에 종속 — 결론(Direction B 채택)은 유지 |
| F4 | PARTIALLY | PtyHandle/pty-runner에 pause/resume 추가 필요 확인; pty-session fake도 보강 |

## Post-gate empirical addendum (2026-07-02)

패키지드 스택(`pty-packaged.spec.ts`, gate B4 스펙) 실측 결과:

- **pause() 배압 확인.** 패키지드 node-pty로 스폰한 firehose 자식이 `pause()` 후 실제로
  정지함(수신 바이트 카운트 증가 없음, CPU ~0%) — F1′의 워커-홉 배압이 실 native
  스택에서 확인됨.
- **raw kill-while-paused가 러너 이벤트 루프를 동기 wedge.** 여전히 paused 상태에서
  (버퍼가 가득 찬 채) `kill()`을 직접 호출하면 호출 프로세스의 Node 이벤트 루프가
  동기적으로 멈춤 — 테스트 자체의 10초 타임아웃도, Playwright의 180초 테스트
  타임아웃도 발화하지 않아 프로세스 트리를 외부에서 강제 종료해야 했음.
- **결론:** 게이트 Q1("resume-then-kill은 유지(방어적)하되 exit 검출의 필요조건은
  아님")의 우려가 실재함이 확인됨 — 앱의 모든 종료 경로(`pty-session.ts`
  `resumeThenKill`, `pty-runner.ts` `killOnce`)가 이미 준수하는 resume-then-kill
  계약이 이 wedge를 방어함. 스펙은 raw kill-while-paused 경로를 인-스위트로 증명하지
  않음(정상적으로 실패할 수 없는 경로) — 대신 앱과 동일하게 resume() 후 kill()하여
  정상 종료를 확인.
