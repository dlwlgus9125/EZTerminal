# 모바일 원격 제어 설계 (Mobile Remote Control)

> 완료 2026-07-05. 데스크톱 EZTerminal을 띄워두면 **안드로이드 앱에서 그 안의 모든 셸 세션을 원격 제어**한다(라이브 출력·키 입력·세션 전환·생성/종료·스크롤백). stats(상태 패널)는 범위 제외. deep-interview 확정, OMC 팀 하네스로 구현(Sonnet 워커).

## 핵심 통찰 — `EzTerminalApi`가 추상화 seam

데스크톱 렌더러와 인터프리터 사이의 경계인 **`EzTerminalApi`(`window.ezterminal`) + per-command `MessagePort` 프로토콜**이 그대로 원격화 지점이다. 데스크톱은 이 API를 preload+IPC+MessagePort로 구현한다. **모바일은 동일 API를 WebSocket으로 구현**하고, `main`에 그 WS를 인터프리터로 중계하는 서버만 추가하면, 렌더러의 `BlockController`와 블록 컴포넌트(`Block`/`PtyBlock`/`TextBlock`/`ResultTable`/`themes`)를 **한 줄도 수정하지 않고 재사용**한다.

```
[안드로이드 앱(Capacitor WebView)]  ── WS ──▶  [데스크톱 main: remote-bridge]  ──▶  [interpreter utilityProcess]
  BlockController(무수정 재사용)                 per-run MessageChannelMain relay        SessionRegistry
  ws-ezterminal.ts (WS 트랜스포트)              토큰 인증(auth 우선, 4001 close)
```

## 데스크톱 브리지 (M0)

- `src/main/remote-bridge.ts` — `ws` 기반 WS 서버. **electron을 import하지 않음**: `RemotePort`/`RemoteMessageChannel`/`RemoteInterpreter`/`RemoteWs` DI seam으로 격리 → `attachConnection`(연결당 프로토콜 로직, 단위테스트 대상)과 `startRemoteBridge`(실제 `WebSocketServer` 바인딩) 분리. `0.0.0.0:7420`(기본, `EZTERMINAL_REMOTE_PORT` override). **첫 메시지가 `{kind:'auth', token}`이 아니거나 토큰 불일치면 즉시 close(4001)**, auth 성공 전 다른 메시지 무시.
- `src/main/main.ts`의 기존 `run-command` 브로커 로직을 복제 — run마다 `MessageChannelMain` 생성, port2를 interpreter로 transfer, port1의 프레임을 `{kind:'frame', runId, frame}`로 WS relay, WS control을 port1로 역중계. `close`/연결 종료 시 포트 정리(누수 방지).
- `src/shared/remote-protocol.ts` — 단일 소켓 멀티플렉싱 봉투 타입(`ClientToServerMessage`/`ServerToClientMessage`)이 기존 `InterpreterFrame`/`RendererControl`을 래핑. **`pty-data`의 `Uint8Array`는 base64 텍스트로 왕복**(`encodeFrame`/`decodeFrame`이 경계 격리; 전역 `atob`/`btoa`만 사용해 브라우저·Node 양쪽 안전).
- `src/main/session-directory.ts` — `main`이 per-command 포트를 안 읽으므로 세션 목록을 위해 `session-created`/`destroy-session` 지점에서 갱신되는 `Map<sessionId,{cwd}>`.
- `src/main/remote-token-store.ts` — `known-hosts-store`/`layout-store`의 versioned-envelope + atomic-write 패턴. 첫 호출 시 랜덤 토큰(crypto) 생성·영속(`userData/remote-token.json`), `getToken`/`rotateToken`.

## 데스크톱 페어링 UI (M4)

- 새 IPC 3종(`remote:get-connection-info`/`get-token`/`rotate-token`) + `EzTerminalApi` 확장 + `src/renderer/ConnectionInfoPanel.tsx`("Pairing" 패널). LAN IPv4 열거는 순수 함수(`remote-connection-info.ts`, 주입 가능 → 단위테스트). 토큰 회전은 **신규 연결부터 적용**(브리지가 매 연결 시 getToken()을 읽음 — 기존 연결 유지).

## 모바일 앱 (M1/M2)

- `mobile/` — Capacitor + Vite + React 서브프로젝트(pnpm workspace). dockview 대신 모바일 셸: `ConnectScreen`(host/token, localStorage 영속) → `SessionSwitcher` → `MobileSessionView`(TerminalPane의 `_ezPort` 핸드셰이크 재현) + `TouchInputBar`(Esc/Tab/Ctrl/방향키).
- `mobile/src/transport/ws-ezterminal.ts` — `WsEzTerminalTransport implements EzTerminalApi`. **per-run 포트를 `FakeMessagePort`(EventTarget)로 에뮬레이트** + `window.dispatchEvent(new MessageEvent('message', {data:{_ezPort}, source:window}))`로 preload의 포트 핸드오프를 재현 → `BlockController` 무수정 재사용. **재연결/백오프 + auth 워치독**(아래).

## 재연결 견고성 (auth 워치독)

한 번의 연결 시도가 `authTimeoutMs`(6s) 안에 `auth-ok`에 도달하지 못하면(소켓이 안 열리거나, 열렸는데 `auth-ok`·`close`가 안 오는 **half-open** 상태) 그 소켓을 버리고 백오프로 재시도한다. 소켓 식별자 가드로 워치독-close와 실제 close가 겹쳐도 재연결이 이중 예약되지 않는다(idempotent). `App.tsx`의 연결 타임아웃은 트랜스포트를 **죽이지 않고** 힌트만 표시 — 서버가 도달 가능해지면 자동 재연결한다.

## 함정 (실측)

1. **`echo`는 이 셸의 명령이 아니다** — 빌트인은 ls/where/sort-by/gen-rows/cd/history/ps/run-script/ssh-connect 뿐이고 Windows에 echo.exe도 없다. 스모크·수동 테스트는 `cmd /c echo hello` 또는 `ls`/`ps` 사용.
2. **`ws`를 Vite가 main.js에 번들하면 첫 WS 프레임에서 크래시**(`bufferutil`/`utf-8-validate` fallback 파손 → `y.unmask is not a function`). `vite.main.config.ts`에서 `ws` externalize + `forge.config.ts` packageAfterPrune으로 실제 패키지 복사(node-pty/ssh2/cap과 동일 패턴).
3. **Capacitor 기본 Android WebView origin이 `https://localhost`** → 평문 `ws://`가 mixed-content로 차단됨 → `capacitor.config.ts`에 `server.androidScheme:'http'`.
4. **Android가 targetSdk 28+에서 cleartext를 기본 차단**(에러 없이 조용히) → `AndroidManifest.xml`에 `android:usesCleartextTraffic="true"`.
5. **jsdom·happy-dom에 진짜 `MessageChannel`이 없고** `window.postMessage`의 transfer list를 무시 → 트랜스포트는 `FakeMessagePort`+`dispatchEvent` 방식(테스트=프로덕션 동일 경로).
6. **`tslib` 미materialize**(`node-linker=hoisted`) → `cap add android` 전에 `pnpm add tslib -w`.
7. **Android SDK는 설치돼 있어도 `ANDROID_HOME` 미설정일 수 있음** — `C:\Users\dlwlg\AppData\Local\Android\Sdk`(개발 머신). "SDK 없음" 오판 금지.

## 테스트 (M3)

`mobile/e2e/smoke.ts` — 실제 데스크톱 앱(`electron.launch`, 격리 userData)을 띄우고 real 토큰(`getRemoteToken`)을 읽어, 부팅된 안드로이드 에뮬레이터에 debug APK를 설치·구동하고 `adb`+`uiautomator`로 UI를 조작해 `cmd /c echo hello`의 출력이 폰까지 도달함을 logcat `[ez-e2e]` 마커로 검증(Appium 불필요). `MobileSessionView`의 test-only MutationObserver가 `[data-testid="text-output"]`를 console.log로 미러 → Android가 logcat 전달. **실기기(Galaxy Z Fold7) + Tailscale로 `ls` 구조화 테이블 출력까지 라이브 왕복 검증 완료.**

## 검증 베이스라인 (2026-07-05)

- root: typecheck 0 · lint 0 · **vitest 418**(신규 remote-bridge 15·token-store 11·protocol 7·session-directory 6·connection-info 7) · playwright e2e 73 · `pnpm audit --prod` 0
- mobile: typecheck 0 · **vitest 23**(트랜스포트 + auth 워치독) · vite build OK · debug APK(~3.9MB)
- 에뮬레이터 e2e 스모크 재현 통과 + 실기기 라이브 페어링 확인

> audit 트레이드오프: `@capacitor/cli>tar`(v6, dev-only 스캐폴딩) 관련 7건은 `pnpm audit --prod`=0이라 게이트를 **prod audit 0**으로 정의. Capacitor 메이저 스큐 리스크 회피.
