# Codex 아키텍처 검증 — Phase 2 (풀스크린 TUI: node-pty + xterm.js)

> 2026-06-30. 코딩 전 게이트(M0). 대상: 승인된 plan `~/.claude/plans/ezterminal-vectorized-tome.md`.
> 방식: Codex(codex-cli 0.142.0) 적대적 read-only 아키텍처 리뷰(plan + 핵심 소스 파일).
> **Verdict: REVISE — 4 blocker.** 전부 plan에 반영하여 해소 후 M1 착수.

## Verdict 요약
REVISE. IPC 전송 결정(블록별 MessagePort 재사용, Uint8Array 클론, 프레임 순서)은 blocker 아님. 4개 blocker는 모두 설계/경계 이슈로 코딩 전 plan 수정 필요.

## Blockers (해소 방법 = plan 반영)
1. **`!` 트리거 엄격성** — 파서의 단독-명령 체크만으론 부족(`evaluate.ts:219`에서 builtin을 resolveExternal보다 먼저 해석). `!ls`(builtin)·`!foo.bat`(batch)가 조용히 잘못 동작.
   → evaluator에서 `interactive && builtin` → `EvalError`; `interactive && spec.shell===true`(batch) → `EvalError`. `!`는 비-batch 외부 프로그램에만 유효. (plan M4 / B1)
2. **PTY 취소 상태** — AC5는 Cancel→`cancelled` 요구. 그러나 `pty.kill()`이 `onExit→end` 유발, renderer(`block-controller.ts:156`)는 `end`를 `done`으로 매핑 → AC5 실패.
   → `runPtySession`에 one-shot 종료상태 가드: abort면 `cancelled` 1회 + 이후 `end` 억제; 정상 종료면 `end`. (plan M3 / B2)
3. **collapse 데이터 유실** — `Block.tsx:82` `{!collapsed && body}`로 접으면 body unmount → PtyBlock unmount 시 xterm/sink 파괴 + 실행 중 PTY 출력 유실.
   → `shape==='pty'`는 collapse여도 PtyBlock mount 유지(CSS hide), dispose+kill은 close에서만. (plan M5 / B3)
4. **core/external 경계** — `PtyHandle`를 `external/pty-runner.ts`에 두고 `pty-stream`을 `core/value.ts`에 추가하면 순수 core가 native 가장자리에 의존.
   → `PtyHandle`(타입 전용, node-pty import X)를 `core/value.ts`에 정의; `external/pty-runner.ts`는 node-pty를 그 인터페이스로 어댑트. (plan M3 / B4)

## 비차단 개선 (반영/추적)
- `pty-resize` 컨트롤 clamp/검증(행 컨트롤은 ResultStore에서 clamp되지만 resize는 아님) → plan M3 반영.
- fake-PTY 프레임 순서 테스트(data<end, cancel이 end 억제, close가 stale 없이 kill) → plan M3 검증 반영.
- **firehose 백프레셔**: `MessagePort.postMessage`는 credit 신호 없음 → `!yes` 무한 큐잉 가능. risk note에서 **추적 follow-up 티켓으로 승격** → plan 반영.
- 블록별 `MessagePort` 유지(기존 broker/preload가 올바른 전송 seam) — 변경 없음.

## 사실 정정
- AutoUnpackNatives는 `**/{.**,**}/**/*.node` append(`@electron-forge/plugin-auto-unpack-natives/.../AutoUnpackNativesPlugin.ts:29`) — 어느 쪽이든 `conpty.dll`/`OpenConsole.exe`는 unpack 안 됨 → 명시 `asar.unpack` 유지.
- Electron `MessagePortMain.postMessage`는 `MessagePortMain[]` 전송만 문서화 → `Uint8Array` PTY 데이터는 **구조화 클론**(zero-copy 아님).
- `utilityProcess.fork`는 Node+포트 활성 올바른 primitive; `RunAsNode:false`가 막지 않음.
- `OnlyLoadAppFromAsar`/`EnableEmbeddedAsarIntegrityValidation`은 unpacked 네이티브 헬퍼 로드를 막는다는 문서 근거 없음(단 unpacked는 ASAR 무결성 보호 밖).
- "resize = SIGWINCH" → `pty.resize(cols,rows)`로 표현. SIGWINCH는 POSIX 한정, Windows ConPTY는 시그널로 노출 안 함.

## 결론
4 blocker 전부 plan 반영 완료(M0 §"M0 Codex 검증 반영"). blocker 0 → **M1 착수 가능.**
