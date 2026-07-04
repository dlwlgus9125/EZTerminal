# Stage C — PTY Firehose Backpressure (Design, C-M2)

> Status: **GATED — Codex REVISE(4 blockers) folded (2026-07-02). Ready for C-M2.**
> Gate record: `docs/research/2026-07-02-codex-pty-backpressure-review.md`
> Problem: `pty-data`는 ResultStore/credit을 의도적으로 우회(xterm이 스크롤백 소유) —
> `!<firehose>`가 렌더러 큐/버퍼를 무한 성장시킴. (렌더러 *통지* 스로틀은 기완료 — 이건 *데이터* 경로.)

## 1. Verified facts (node-pty 1.1.0 — Codex 감사 반영)

| # | Fact |
|---|------|
| F1′ | `pause()/resume()` = 앱측 `_agent.outSocket`의 socket pause (`terminal.js:122-128`). **Windows는 워커 홉 경유**: ConPTY conout → 워커 스레드 pipe → 앱 소켓 (`conoutSocketWorker.js:12-14`, `windowsConoutConnection.js:100-101`). 배압은 {워커 파이프 + 앱 소켓} 두 유한 버퍼를 채운 뒤 child를 블록 — "즉시"가 아닌 "유한 상수 뒤" 정지. **실측 필수(§6).** |
| F2 | `handleFlowControl` = 동일 pause 메커니즘 + 사용자 입력 Ctrl+S/Q 하이재킹 → 채택 안 함 |
| F3 | 공개 `onExit`은 outSocket 'close'에서 발화하나 destroy는 paused와 무관하게 close를 발화; 앱 취소 응답성은 onExit 비의존(`PtySession.onAbort`가 즉시 `cancelled` 방출) |
| F4 | 입력은 별도 `inSocket` — **paused 중에도 타이핑/Ctrl+C가 child에 도달** |

## 2. Protocol — 바이트 ack (행 credit과 동형; 게이트 B3 해소)

boolean XON/XOFF(무ack)는 in-flight 상한을 증명할 수 없음 → **pause 결정을 sent
카운터가 있는 인터프리터로 이동**:

- **인터프리터(PtySession):** `sent += chunk` 후 `pty-data` 방출.
  `sent - acked > HIGH_WATER(1 MiB)` → `pty.pause()`.
  `pty-ack` 수신으로 `acked` 갱신 후 `sent - acked ≤ LOW_WATER(256 KiB)` → `resume()`.
- **렌더러(BlockController):** `consumed`는 **xterm이 실제 flush한 시점**(term.write cb)
  에만 증가. `consumed - lastAcked ≥ ACK_QUANTUM(64 KiB)`마다
  `{type:'pty-ack', bytes: consumed}` 전송 (누적값 — 유실/재정렬에 단조 안전).
- **유계성(구성적):** 인터프리터는 unacked > HIGH에서 멈추므로 포트 큐 + 컨트롤러
  pre-sink 버퍼 + xterm 대기 총합 ≤ HIGH + 1청크. **pre-sink 버퍼(게이트 B2)도 이
  상한 안** — sink 등록 전엔 ack가 0이므로 인터프리터가 HIGH에서 pause.
- sink 미등록/write cb 미발화 → 영구 pause 가능하나 **cancel 경로는 flow와 독립**
  (F3: kill 즉시 cancelled) — 사용자 탈출구 보장.

`src/shared/ipc.ts` additive: `PtyAckControl { type:'pty-ack'; bytes: number }`.
(인터프리터→렌더러 신규 프레임 없음.)

## 3. Touch points

```
src/shared/ipc.ts                 PtyAckControl 추가 (RendererControl union)
src/interpreter/core/value.ts     PtyHandle에 pause()/resume() 추가
src/interpreter/external/pty-runner.ts  IPty 위임 + killOnce는 resume-then-kill
src/interpreter/pty-session.ts    sent/acked/paused 상태기계 + ack(bytes) + 종료 경로 resume
src/interpreter/interpreter-process.ts  control 스위치에 'pty-ack' 라우팅
src/renderer/block-controller.ts  consumed/ack-quantum 계측(sink cb 기반) + __ezPtyFlow seam
src/renderer/PtyBlock.tsx         sink가 (bytes, onFlush) 형태로 term.write(data, cb) 연결
e2e/pty-backpressure.spec.ts      firehose 유계 + paused 중 취소
e2e-packaged/pty-packaged.spec.ts firehose→pause→성장 정지→paused kill→onExit (게이트 B4)
```

## 4. Verification

**유닛(fake seam):** pty-session — HIGH 초과 시 pause 1회/ack로 LOW 이하 시 resume 1회
(히스테리시스·중복 흡수)/ack 단조(감소 무시)/settled 후 no-op/모든 종료 경로 resume-then-kill.
pty-runner — pause/resume 위임 + killOnce 순서. block-controller — flush 시점 ack 방출·
ACK_QUANTUM 양자화·pre-sink 버퍼는 ack 미발생.

**e2e:** `!node -e "for(;;)process.stdout.write('y'.repeat(8192))"` —
① `window.__ezPtyFlow()`={received,consumed}로 `received - consumed ≤ HIGH + 64KiB` 5초 유지
② firehose 중(대부분 paused) Cancel → 5초 내 `cancelled` ③ 기존 29 무회귀(정상 TUI 무영향).

**패키지드(게이트 B4):** pty-packaged.spec.ts 확장 — 패키지드 node-pty로 firehose 스폰 →
1초 수집 → `pause()` → 정지 확인(t+1s 카운트 == t+3s) → **paused 상태에서 kill →
onExit 10초 내 발화** (F1′ 워커-홉 배압 + F3 paused-kill을 실 native 스택에서 실측).

## 5. Risks (개정)

| Risk | Mitigation |
|---|---|
| 워커-홉 상수(수백 KB급 파이프 버퍼)로 정지 지연 | 상한은 여전히 유한 — packaged 실측으로 고정 (§4) |
| raw kill-while-paused는 호출자를 동기적으로 wedge시킴이 패키지드 실측으로 확인됨(2026-07-02) | resume-then-kill이 선택이 아니라 필수임이 실증됨 — 모든 종료 경로(`resumeThenKill`/`killOnce`)가 이미 이를 준수 |
| ack 유실/포트 종료 → 영구 pause | 누적 ack(멱등) + cancel 독립 경로 + 종료 시 인터프리터 자체 정리 |
| write cb 미발화 | cancel 탈출구; 세션 종료가 최종 회수 |
| HIGH/LOW 오설정으로 정상 TUI pause | vim/htop급 ≪ 1MiB 미배수 상황 없음; e2e 무회귀로 고정 |
