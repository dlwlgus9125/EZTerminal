# 외부 도구 통합 계약

> 문서 상태: **활성 규범 계약**
>
> 범위: OpenClaw gateway와 Codex·Claude 등 Agent CLI의 관찰, 실행, 이력, 승인과
> desktop/mobile 표시 경계.

## 공통 원칙

OpenClaw와 Agent CLI는 EZTerminal이 소유하는 내부 service가 아니다. EZTerminal은
사용자가 설치·선택한 외부 프로세스를 bounded adapter로 관찰하거나 명시적 동작을
위임한다.

- 앱 종료는 외부 gateway 또는 사용자 Agent 프로세스의 시스템 수명을 임의로
  변경하지 않는다. EZTerminal이 시작한 terminal run과 구독만 정리한다.
- 명령, transcript, token, 설정 원문과 승인 payload를 일반 진단 로그에 기록하지
  않는다.
- desktop과 mobile은 main의 동일 service를 사용하고 외부 protocol을 UI에서 직접
  구현하지 않는다.
- 설치 안 됨, 중지, offline, 권한 부족과 protocol 오류를 정상 빈 상태와 구분한다.

## OpenClaw

`OpenClawService`가 gateway endpoint, WS RPC, 물리 상태·세션·로그 polling과 허용된 설정
변경을 소유한다. Windows의 시작·중지·재시작 기대 상태는
`OpenClawLifecycleCoordinator`와 EZTerminal 소유 current-user supervisor가 소유한다.

- 기본 endpoint는 loopback gateway이며 환경 또는 OpenClaw 설정에서 유효한 HTTP
  origin만 선택한다.
- 시작·중지·재시작 요청은 먼저 generation이 있는 durable intent로 원자 저장하고 즉시
  접수 결과를 반환한다. 같은 활성 intent는 합치고 충돌 intent는 더 높은 generation으로
  대체하여 마지막 요청이 이긴다. 앱 종료는 intent나 supervisor를 취소하지 않는다.
- Windows supervisor는 로그인 때 저장된 켜짐/꺼짐 의도를 복원하고 15초마다 실행 상태를
  관찰한다. Start는 해당 OpenClaw 작업을 등록·활성화한 뒤 `gateway start --json`,
  Stop은 자동 시작을 비활성화한 뒤 `gateway stop --force --json`을 사용한다.
  명시적 Restart는 중지→시작이며 완료된 Restart를 재로그인 때 반복하지 않는다.
- `/healthz`는 실행 상태, `/startupz`는 준비 상태를 나타낸다. 관리 RPC는 세션·로그·버전의
  별도 연결 상태이며 실행 성공이나 자동 재시작 조건이 아니다. 살아 있는 프로세스는 최대
  120초 동안 시작을 기다리고, 종료가 확인된 경우에만 재실행한다. 실패는 최대 3회까지
  재시도한 뒤 실제 명령 오류와 다음 행동을 표시한다.
- 일반 실행은 Doctor, session/approval/workspace 이전, 복구 백업 또는 강제 재설치를
  수행하지 않는다. 데이터·설정 복구는 사용자가 먼저 Stop을 선택한 뒤 상세 영역의 공식
  수동 명령 안내에 따라 실행한다. 기존 설정·인증·세션과 복구 백업은 보존한다.
- 상태 관측 시각과 supervisor heartbeat는 별개다. 오래된 runtime이나 응답 없는
  supervisor의 작업은 새 요청을 합치거나 버튼을 잠그는 근거로 사용하지 않는다.
  배포된 script가 바뀌면 이전 supervisor를 교체하며, 이전 버전의 데이터 복구가 진행
  중이면 완료를 기다린다. gateway 프로세스는 이 교체만으로 재시작하지 않는다.
- `dispose()`는 polling, RPC와 child handle을 정리할 뿐 gateway 또는 supervisor 기대 상태를
  대신 종료하지 않는다. 기존 직접 autostart 등록 UI는 supervisor가 대체한다.
- 설정 변경은 명시된 allowlist만 허용하며 gateway 설정 파일을 EZTerminal이 직접
  편집하지 않는다. port 변경은 restart 뒤 origin을 다시 계산한다.
- desktop chat은 main-owned `WebContentsView`를 sandbox/context-isolation 상태로
  사용한다. `main-owned`은 main process가 수명을 소유한다는 뜻이며 표시 host는 chat
  panel이 있는 main 또는 auxiliary `BrowserWindow`다. Panel이 창 사이를 이동하면 같은
  view를 새 host에 재부착한다. gateway token은 main이 URL fragment에 넣고 renderer
  IPC로 전달하지 않는다.
- Renderer는 monotonic revision을 가진 하나의 surface snapshot으로 host window name,
  bounds, visibility와 mount/unmount를 원자적으로 알린다. Main은 등록된 창 이름과 sender를
  검증하고 stale revision 및 구형 개별 geometry/visibility update를 받아들이지 않는다.
- navigation은 gateway origin으로 제한하고 새 창은 안전한 external URL 정책을 거쳐
  시스템 browser로 보낸다. drawer, modal 또는 숨은 panel 뒤에서는 view를 숨겨 click
  interception을 막는다.
- mobile chat은 실제 gateway token 대신 60초 one-time ticket으로 proxy session을
  시작한다. proxy는 connection·header·idle·session 상한을 적용하고 gateway origin/CSP
  경계를 명시적으로 다시 쓴다.
- mobile ticket 발급은 desktop runtime, gateway 상태, token과 proxy 가용성을 확인하지만
  OpenClaw 2026.8.1에서 폐기된 `gateway.controlUi.allowInsecureAuth`를 조회하거나 변경하지
  않는다. plain HTTP에서도 Control UI의 정상 device-identity/pairing flow를 사용한다.

## Agent 실행과 상태

- Agent launcher catalog와 설정은 main-owned store에서 제공한다. 실행 요청은 launcher,
  session/run identity와 canonical project 또는 directory target을 모두 검증한다.
- Agent 실행은 새 terminal session에서 수행한다. Codex/Claude용 bootstrap은 선택한
  project roots와 실제 PTY cwd가 일치한 뒤에만 명령을 보낸다.
- project store는 관찰된 root와 사용자 pin을 구분한다. 실패하거나 취소된 direct-folder
  launch를 성공한 project처럼 저장하지 않는다.
- `AgentActivityService`가 terminal 실행과 provider hook event를 하나의 상태로 합친다.
  starting, working, blocked, done, seen-idle, error와 unknown의 의미를 UI별로
  재구현하지 않는다.
- provider permission hook은 사용자의 명시적 승인/거부까지 bounded하게 대기한다.
  integration이 꺼지거나 요청이 대체·만료되면 hook을 남겨 두지 않는다.
- prompt는 done/idle이고 structured PTY input이 준비된 해당 run에만 전달하고 길이를
  제한한다. Project 참여와 Agent 간 제어는
  [`agent-collaboration.md`](agent-collaboration.md)가 소유한다.

## Agent 이력과 개인정보

- Codex history는 app-server JSON-RPC adapter를, Claude history는 로컬 provider 기록
  adapter를 사용한다. provider별 원본 형식을 renderer나 mobile에 노출하지 않는다.
- list와 transcript page는 bounded pagination을 사용한다. UI에 필요한 role, time,
  project/provider identity와 markdown만 공유 계약으로 변환한다.
- Agent Hub와 Android Agent 화면은 같은 main service의 snapshot과 page를 사용한다.
- notification에는 prompt나 transcript를 넣지 않고 provider, 상태와 focus target만
  포함한다.
- history 읽기 실패가 live terminal 실행을 중단하거나 외부 파일을 수정해서는 안 된다.

## UI와 원격 경계

desktop Agent sidebar, history panel, launch picker와 mobile 대응 화면의 배치·포커스·색상
계약은 [`frontend-design.md`](../ux/frontend-design.md)가 소유한다. Remote protocol은
Agent live/history/projects/launch capability를 version별로 검증하고, 지원하지 않는
client에 일부 payload를 보내지 않는다.

## 근거 소스

- [`src/main/openclaw-service.ts`](../../src/main/openclaw-service.ts)
- [`src/main/openclaw-lifecycle-coordinator.ts`](../../src/main/openclaw-lifecycle-coordinator.ts)
- [`assets/openclaw-supervisor.ps1`](../../assets/openclaw-supervisor.ps1)
- [`src/main/openclaw-chat-view.ts`](../../src/main/openclaw-chat-view.ts)
- [`src/main/openclaw-chat-ticket.ts`](../../src/main/openclaw-chat-ticket.ts)
- [`src/main/openclaw-proxy.ts`](../../src/main/openclaw-proxy.ts)
- [`src/main/agent-activity-service.ts`](../../src/main/agent-activity-service.ts)
- [`src/main/agent-history-service.ts`](../../src/main/agent-history-service.ts)
- [`src/main/agent-hook-relay.ts`](../../src/main/agent-hook-relay.ts)
- [`src/main/agent-project-store.ts`](../../src/main/agent-project-store.ts)
- [`src/main/codex-app-server-client.ts`](../../src/main/codex-app-server-client.ts)
- [`src/main/claude-history-adapter.ts`](../../src/main/claude-history-adapter.ts)
- [`src/shared/agent-history.ts`](../../src/shared/agent-history.ts)

## 검증

- [`src/main/openclaw-service.test.ts`](../../src/main/openclaw-service.test.ts)
- [`src/main/openclaw-lifecycle-coordinator.test.ts`](../../src/main/openclaw-lifecycle-coordinator.test.ts)
- [`src/main/openclaw-supervisor-script.test.ts`](../../src/main/openclaw-supervisor-script.test.ts)
- [`src/main/openclaw-chat-view.test.ts`](../../src/main/openclaw-chat-view.test.ts)
- [`src/main/openclaw-chat-ticket.test.ts`](../../src/main/openclaw-chat-ticket.test.ts)
- [`src/main/desktop-window-manager.test.ts`](../../src/main/desktop-window-manager.test.ts)
- [`src/shared/openclaw.test.ts`](../../src/shared/openclaw.test.ts)
- [`src/main/openclaw-proxy.test.ts`](../../src/main/openclaw-proxy.test.ts)
- [`src/main/agent-activity-service.test.ts`](../../src/main/agent-activity-service.test.ts)
- [`src/main/agent-history-service.test.ts`](../../src/main/agent-history-service.test.ts)
- [`src/main/agent-project-store.test.ts`](../../src/main/agent-project-store.test.ts)
- [`e2e/openclaw-chat.spec.ts`](../../e2e/openclaw-chat.spec.ts)
- [`e2e/agent-history.spec.ts`](../../e2e/agent-history.spec.ts)

OpenClaw 최초 조사와 구현 계획은
[`openclaw-management-design.md`](../archive/design/openclaw-management-design.md) 및
[`2026-07-12-openclaw-stage0.md`](../archive/research/2026-07-12-openclaw-stage0.md)에
보존한다.
