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
- Windows supervisor는 사용자 로그인 때 등록되고 15초 quick check와 5분 authenticated
  RPC check로 `running`/`stopped` 기대 상태를 유지한다. 외부에서 중지된 running 상태는
  복구하고, stopped 상태에서 외부로 시작된 gateway는 다시 중지한다.
- 실행 성공은 CLI exit code가 아니라 `/startupz`와 인증된 `status` RPC가 5초 동안
  안정적으로 통과했을 때만 기록한다. 재시작은 active work를 최대 60초 기다린 뒤 bounded
  force 경로를 사용한다.
- 자동 복구는 진단 → 대상 파일 SHA-256 검증 백업 → 지원되는 비대화형 session SQLite
  import와 approval import → `doctor --fix --non-interactive` 순서의 비파괴 경로만 사용한다.
  approval import는 제한된 staging 파일과 표준 입력을 사용하고 실패하면 원본을 복구한다.
  package 설치·업데이트, 데이터 삭제/reset, token 생성, 인증 약화와 aggressive doctor는
  자동 실행하지 않는다. 세 번 실패하거나 CLI 호환성, 백업, 권한, unrelated port/task
  충돌을 만나면 새 명시적 요청 전까지 blocked로 남긴다.
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
