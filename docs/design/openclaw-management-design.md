# OpenClaw 관리 기능 설계 (OpenClaw Management)

> 완료 2026-07-12. EZTerminal 안에서 로컬 **OpenClaw**(개인 AI 어시스턴트 게이트웨이, 예약작업 "OpenClaw Gateway"로 `127.0.0.1:18789` 상시 구동)를 관리한다 — 상태·수명주기·세션·로그·설정 + **채팅**(Control UI 임베드), 데스크톱과 모바일 양쪽 전체 패리티. deep-interview 확정(`.omc/specs/deep-interview-openclaw-management.md`), OMC team 하네스로 구현(Wave 0~4).

## 수명주기 위임 모델 — EZTerminal은 게이트웨이를 소유하지 않는다

OpenClaw는 Windows 예약작업으로 상시 구동되는 별개 프로세스다. EZTerminal은 **관찰+제어 위임**만 한다: 상태 조회는 WS RPC(`health`/`status`/`sessions.list`)로 직접, 시작/중지/재시작은 `openclaw gateway start|stop|restart` CLI 호출을 그대로 위임한다. **EZTerminal을 종료해도 게이트웨이는 무영향**(`before-quit`의 `dispose()`는 구독·자식 프로세스만 정리, 게이트웨이 프로세스는 절대 건드리지 않음). 설정 변경도 `openclaw config get/set`을 경유하며 EZTerminal이 독자적으로 설정 파일을 쓰지 않는다.

## 데스크톱 드로어 (`src/renderer/OpenClawPanel.tsx`)

`StatusPanel` 선례를 따르는 우측 비모달 드로어(헤더 "OpenClaw" 버튼, Stats/Pairing/Settings와 상호배제). 상태 헤더(설치 안 됨/중지됨/시작 중/실행 중) + 수명주기 버튼(시작/중지/재시작, busy 시 비활성) + 세션 목록(5초 폴) + 로그 테일(WS `logs.tail` RPC, 2초 폴) + 핵심 설정 폼(`OPENCLAW_CONFIG_ALLOWLIST = ['agents.defaults.model', 'gateway.port']`만 편집 가능, 저장 후 "재시작 필요" 배너). **안내 상태가 우선**: 미설치 → CLI 설치 가이드 카드(`npm i -g openclaw`), 중지됨 → 시작 CTA — 오류 다이얼로그는 절대 띄우지 않는다.

## 데스크톱 채팅 패널 (`src/main/openclaw-chat-view.ts` + `OpenClawChatPanel.tsx`)

새 dockview 패널 타입 `openclaw-chat`(레이아웃 스키마 union 확장, `LAYOUT_SCHEMA_VERSION` 유지, additive라 기존 저장 레이아웃 전부 유효). 채팅 콘텐츠는 iframe이나 webview 태그가 아니라 **메인 프로세스가 소유하는 `WebContentsView`**(Control UI가 `X-Frame-Options: DENY`+CSP `frame-ancestors 'none'`으로 임베드 자체를 거부하기 때문 — 실측 확인). 렌더러의 dockview 패널은 `ResizeObserver`로 자기 bounds/가시성만 IPC로 메인에 보고하는 플레이스홀더일 뿐이다. 뷰는 `sandbox:true, contextIsolation:true`, preload 없음, 전용 파티션 `persist:openclaw-chat`(앱 세션·CSP와 격리), `will-navigate`을 게이트웨이 origin으로 제한, `setWindowOpenHandler`는 외부 브라우저로. **토큰은 메인이 `#token=` 프래그먼트로 URL을 조립해 뷰에 직접 로드하며 렌더러에는 절대 전달되지 않는다.** 드로어나 커맨드 팔레트가 열려 있거나 패널이 비가시 상태면 `setVisible(false)`(단일 "유효 가시성" 계산).

**실 게이트웨이로 완전 검증됨(AC2):** 뷰가 게이트웨이 자기-origin(`http://127.0.0.1:18789#token=…`)을 로드해 실제 "ping"→"pong"(GPT-5.5) 왕복까지 확인, 스크린샷 `%TEMP%\claude\ezterminal-openclaw-ac2\`. 데스크톱은 `http://127.0.0.1`이 브라우저 secure context이기 때문에 이 채팅 경로가 **추가 설정 없이 그대로 동작**한다 — 아래 모바일 절과 대비되는 지점.

## 모바일 관리 (`mobile/src/MobileOpenClawView.tsx`)

탭 4개: 상태 | 로그 | 설정 | 채팅. 데스크톱과 **같은 `OpenClawService` 인스턴스**를 기존 원격 제어 WS 브리지(`remote-bridge.ts`)에 새 메시지군(`openclaw-status/-lifecycle/-logs/-config/-chat-ticket`)으로 얹어 재사용 — `RemoteOpenClawSource` DI 시임은 `RemoteStatsSource` 선례를 따른다. 상태/로그는 그 탭이 활성인 동안만 구독. `remoteEnabled`가 꺼져 있으면(기본 OFF) 모바일 관리·채팅 전부 비활성.

## 모바일 채팅 — EZTerminal 역프록시 (`src/main/openclaw-proxy.ts`)

Tailscale 태넷 위에서 폰이 게이트웨이(`127.0.0.1:18789`, 루프백 전용 바인딩)에 직접 붙을 수 없으므로, EZTerminal이 `node:http` 역프록시를 자체 소유한다. 기본 포트 `7421`(`EZTERMINAL_OPENCLAW_PROXY_PORT`로 override), `0.0.0.0` 바인딩, **수명주기는 `remoteEnabled` 토글과 완전히 같은 직렬화(`bridgeOp`)를 공유** — 원격 제어가 꺼져 있으면 프록시도 없다.

**인증:** 폰이 이미 인증된 WS 브리지로 티켓을 요청 → 메인이 `randomBytes(32)` 1회용 티켓 발급(TTL 60초) → 폰이 `http://<접속 중인 호스트>:7421/?t=<티켓>#token=<gw토큰>`을 iframe에 로드 → 프록시가 티켓을 상환한 뒤 그 커넥션을 **소스 IP에 바인딩**(쿠키가 아님 — 폰 origin `http://localhost`과 프록시 origin이 달라 `SameSite=Lax` 쿠키가 cross-site iframe에서 전송되지 않기 때문. Tailnet IP 자체가 이미 기기 인증 신호이므로 브리지 인증+티켓과 함께 다층 방어). 이후 HTTP 요청과 WS 업그레이드를 게이트웨이로 그대로 파이프하되, **Origin/Host를 게이트웨이 자기-origin(`http://127.0.0.1:18789`)으로 재작성**(`gateway.controlUi.allowedOrigins`가 프록시 origin을 거부하므로 필수) + `X-Frame-Options` 제거 + CSP `frame-ancestors`를 **모바일 앱 origin(`http://localhost`)으로**만 재작성한다(프록시 자기 주소를 넣으면 오히려 전체 임베드가 막히는 잠복 버그였음 — M4 수정 ③).

## 남은 벽 — 모바일 채팅 사전조건 (코드로 해결 불가)

세 겹 방어(IP-바인딩 인증, Origin 재작성, frame-ancestors 재작성)를 전부 통과해 Control UI 앱 자체는 폰 iframe에 실제로 로드된다(`scratchpad/m5-evidence2/02-chat-tab-iframe.png` — Gateway Dashboard 앱 셸이 뜬다). 하지만 최종 단계에서 앱 자신이 이렇게 막는다:

> **"Secure browser context required"** — `http://<lan-ip>`는 브라우저 insecure context라 Gateway가 요구하는 device identity를 생성할 수 없다.

데스크톱은 `http://127.0.0.1`이 Chromium에서 secure context 취급이라 이 벽에 걸리지 않는다 — 폰만 LAN IP로 접속하기 때문에 겪는 문제다. **EZTerminal 코드로 우회할 수 없다** — 게이트웨이 호스트(PC)에서 사용자가 직접:

```
openclaw config set gateway.controlUi.allowInsecureAuth true
```

를 실행하고 게이트웨이를 재시작해야 한다. **(2026-07-12 갱신: 사용자 승인으로 이 사전조건이 라이브 게이트웨이에 실제 적용·재시작됨 — 새 PID 34512. 실 왕복 검증(에뮬레이터)은 이 M6 스윕 범위 밖이라 리드가 별도로 진행한다.)** 이 설정은 device-identity 검증을 완화해 토큰만으로 로그인을 허용하는 것 — Control UI 자신의 안내문도 "원격 HTTP 접근에 대해서는 device auth를 끄지 말 것"이라고 경고한다(트레이드오프: 신뢰하는 Tailnet 안에서만 프록시가 노출되므로 허용 가능한 범위지만, 게이트웨이 자체의 보안 완화라는 점은 분명히 인지해야 한다). **대안은 HTTPS 또는 Tailscale Serve**(게이트웨이 호스트에 TLS 종단을 두는 방식)이며, 계획서는 이 경로를 의도적으로 기각했다 — EZTerminal은 사용자의 OpenClaw 설치·네트워크 노출을 대신 바꾸지 않는다는 원칙 때문이다. 이 설정은 **사용자의 결정**이며 EZTerminal이 대신 실행하지 않는다.

## 원격/프록시 옵트인

모바일 관리·채팅 전체가 기존 원격 제어(`remoteEnabled`, 기본 **OFF**)에 종속된다. 별도의 "OpenClaw 원격 노출" 스위치는 없다 — 이미 원격 제어를 켠 사용자만 모바일에서 OpenClaw도 보인다. `remoteEnabled`를 끄면 WS 브리지와 함께 프록시(7421)도 완전히 내려간다.

## 함정 (실측)

1. **Control UI는 iframe/webview 태그 임베드를 헤더로 원천 차단** — `WebContentsView`(메인 소유)만 유일한 경로.
2. **`config get` exit 1 = unset 시그널**(오류 아님) — `gateway.port`는 실설치 기본값이 unset.
3. **`config set`은 재시작 필요**("Restart the gateway to apply") — 설정 폼에 배너 필수.
4. **npm shim spawn**(.ps1/.cmd) — `.cmd` 해석 + cross-spawn args 배열(셸 문자열 금지).
5. **CLI 상태 호출이 9~18초** — 폴링 대상에서 제외, 읽기는 WS RPC-first(`health`/`status`/`sessions.*`)로 개정.
6. **쿠키 인증이 cross-site iframe에서 조용히 실패** — 소스 IP 바인딩으로 개정(M5 amendment ①).
7. **frame-ancestors에 프록시 자기 origin을 넣으면 전체 임베드가 막힘** — 모바일 앱 origin으로 재작성해야 함(M5 amendment ③).
8. **토큰은 CLI로 조회 불가**(`__OPENCLAW_REDACTED__` 마스킹) — `~/.openclaw/openclaw.json` 직접 읽기가 유일한 경로.

## 검증 베이스라인 (2026-07-12, M6 스윕)

- root: typecheck 0 · lint 0(경고 2건, 무관 pre-existing — App.tsx import/no-duplicates) · **vitest 865/865**
- `rm -rf .vite && pnpm e2e`: **123 passed / 1 failed (124 total)** — 실패는 `e2e/status-panel.spec.ts:47`(Stats 패널 바운딩박스), OpenClaw 헤더 버튼을 `display:none`으로 숨기고 단독 재실행해도 동일하게 재현되는 것을 확인해 **OpenClaw 기능과 무관한 기존 환경성 플레이크로 확정**(원인 격리 완료)
- `EZ_OUT_DIR=out-openclaw pnpm run test:e2e:packaged`: **8/8 통과**
- `guard:pty-routing` **35/35 그린** · `guard:native`(node-pty)·`guard:native-cap`(cap) **전부 그린**(out-openclaw 빌드 대상, node-pty/conpty 5종+cap.node 전부 app.asar.unpacked 확인)
- mobile: typecheck 0 · **vitest 147/147**
- 시각 검증: 데스크톱 드로어 3상태(미설치/실행 중/중지됨) + 채팅 패널 4상태(닫힘 시 표시/드로어 열림 시 숨김/중지 안내/재시작 후 복원) + AC2 실 게이트웨이 왕복 2장 + 모바일 상태·로그 탭(m5-evidence) + 모바일 채팅 iframe(Control UI 앱 로드 확인, insecure-context 안내 카드까지, m5-evidence2) — 전부 직접 Read로 육안 확인.
- 실기기(Tailscale) 모바일 채팅 최종 확인은 위 사전조건(`allowInsecureAuth`) 적용 후 리드가 별도 진행.
