# Local Agent Runtime 및 오케스트레이션 계약

> 문서 상태: **활성 규범 계약**
>
> 범위: Windows 10/11 x64 host, Electron Desktop, Android companion에서 동작하는
> Project/Workspace/Session 모델, 구조화된 Agent 실행, 관리형 child Agent, provider,
> 로컬 automation과 복구 경계.

EZTerminal은 Paseo의 공개된 사용 경험을 참고하되 코드, asset, schema를 복사하지 않는
clean-room 구현이다. 이 릴리스 범위에는 relay, voice, 외부 Hub, Web/iOS, 다중 사용자 계정이
없다. 기존 terminal, remote pairing, worktree diff/review와 명시적 merge는 유지한다.

## 제품 모델

기본 정보 구조는 **Project → Workspace → Session**이다.

- Project는 저장소 또는 지속적인 사용자 작업 맥락이다.
- Workspace는 local checkout이나 EZTerminal이 관리하는 worktree다.
- Session은 Agent, Terminal, Diff/Review, opt-in Browser, Script 또는 Service다.
- 기존 독립 terminal은 접근 가능한 경로를 기준으로 Local workspace에 비파괴적으로 등록한다.
- tab을 닫는 것은 layout 동작이며 실행, transcript 또는 provider history를 삭제하지 않는다.

`새 에이전트`는 modal이 아닌 draft tab이다. provider/model, workspace, 첫 prompt와 다음 세
permission preset을 한 화면에서 편집한다.

- `Plan`: 탐색과 계획 중심, 변경 작업은 승인 필요
- `Standard`: 필요할 때 승인을 요청하는 기본값
- `Full access`: 명시적으로 선택한 session에 한해 넓은 권한

provider session과 process는 첫 Send에서만 만든다. 새 Codex session은 Codex app-server,
새 Claude session은 Claude Agent SDK의 streaming input으로 실행한다. 기존에 실행 중인 legacy
PTY Agent는 자연스럽게 끝날 때까지 유지하고, 새 session과 history resume은 구조화된 경로를
사용한다. Agent transcript는 terminal 색과 밀도를 공유하는 semantic renderer이며 raw CLI/TUI는
Terminal session에만 남는다.

## DaemonRuntime과 권위

Electron main process가 user-level `DaemonRuntime`의 유일한 writer다. 별도 executable이나
Windows service를 추가하지 않는다. renderer, Android, CLI와 session-scoped MCP는 모두 client며
추정한 local state를 권위 상태처럼 저장하지 않는다. 기존 interpreter utility는 terminal executor로
유지한다.

기본 설정에서 main 창 닫기와 Quit은 모든 child process를 정리하고 종료한다. `계속 실행`을 켜면
창을 닫아도 main과 tray가 살아 있고, `시작 시 실행`을 켜면 user login에 등록한다. 첫 schedule 또는
heartbeat 활성화는 두 설정을 함께 켤지 한 번 설명한다. 사용자가 취소하거나 login 등록에 실패하면
automation도 활성화하지 않는다. 명시적 Quit은 설정과 무관하게 모든 실행을 중단한다.

모든 provider, adapter와 terminal process는 `ProcessGuardian`에 등록한다. daemon crash나 정상
shutdown 뒤에 소유권 없는 process가 남지 않아야 한다. 재시작 시 provider history와 command
outbox를 대조하고 확인할 수 없는 제출은 `delivery-uncertain`으로 표시하며 자동 재전송하지 않는다.

## 공통 command/event protocol

[`src/shared/daemon-protocol.ts`](../../src/shared/daemon-protocol.ts)가 Desktop IPC, Android
WebSocket, CLI와 MCP의 공통 command, snapshot과 event를 소유한다.

- 모든 mutation은 stable `commandId`, `idempotencyKey`, client principal과
  `expectedRevision`을 가진다.
- snapshot은 단조 증가하는 revision과 event sequence를 포함한다.
- event는 단조 증가하고 reconnect client가 gap을 snapshot으로 복구할 수 있어야 한다.
- stale revision, 권한 거부, hard cap, delivery uncertainty는 구조화된 오류로 반환한다.
- remote protocol은 v12다. 이전 client에는 모호한 disconnect 대신 명시적 upgrade 오류를 보낸다.
- principal은 Desktop, Android paired device, local CLI, session MCP와 provider runtime별 allowlist를
  가진다. MCP token은 session-scoped이며 영구 저장하지 않는다.

local CLI는 ACL이 제한된 loopback descriptor와 bearer를 사용한다. command router가 principal별
권한을 검사한 뒤 같은 mutation을 실행하므로 Desktop/Android/CLI/MCP 사이에 별도 business logic을
만들지 않는다.

## 영속성, outbox와 migration

runtime state는 Electron에 포함된 `node:sqlite`의 `orchestration.sqlite3`에 저장한다. WAL,
foreign key, serialized writer와 bounded transcript delta batch를 사용한다. 최소 Node 버전은
`22.13`이다. UI layout, theme와 device-only preference는 기존 JSON owner를 유지한다.

주요 table은 projects, workspaces, sessions, agent_relations, turns, transcript_items,
command_outbox, approvals, providers, schedules, schedule_runs와 revisioned_events다. mutation은
write-ahead outbox에 먼저 기록한 뒤 provider로 전달한다. Codex에는 `commandId`를
`clientUserMessageId`로 사용하고 다른 provider도 가능한 native idempotency key를 연결한다.

최초 migration은 기존 JSON/layout의 timestamp와 SHA-256 manifest를 가진 backup을 먼저 만든다.
import는 반복 실행해도 같은 row를 중복 생성하지 않는다. 원본을 삭제하지 않으며 기존 collaboration
policy/run은 read-only archive metadata로만 보존하고 적용하지 않는다. DB 생성이나 import가 실패하면
새 DB를 quarantine하고 terminal-only safe mode로 시작한다.

safe mode는 프로세스 수명 동안 latch되며 같은 프로세스에서 DB 재생성이나 자동 재시도를 하지 않는다.
기존 terminal과 remote terminal은 계속 사용하되 구조화 Agent snapshot, transcript, event와 command는 fail-closed된다.
Desktop은 초기화 원인, DB 보존/격리 상태, 스키마 버전, 다음 조치와 trusted recovery path를
보여 준다. Android에는 같은 원인과 조치를 보이지만 host의 로컬 recovery path는 protocol type과
직렬화 경계에서 제거한다. New Agent 진입점은 비활성화하고 UI retry loop를 만들지 않는다.

## Provider adapter

모든 구조화 provider는 다음 deep interface를 구현한다.

1. 설치/버전 probe와 model 목록
2. session create/resume
3. prompt submit과 interrupt
4. model/permission setting 변경
5. approval request/resolve
6. semantic event stream
7. history/outbox reconciliation
8. deterministic dispose

지원 catalog는 다음과 같다.

| Provider | 실행 경계 |
| --- | --- |
| Codex | `codex app-server` |
| Claude | Claude Agent SDK + 사용자가 설치한 Claude CLI |
| OpenCode | `opencode acp` |
| Gemini | `gemini --acp` |
| Copilot | `copilot --acp --stdio` |
| Pi | `pi --mode rpc --no-session` |
| Custom | 서명된 `.ezadapter` 또는 사용자가 검토한 ACP command |

활성화 화면은 canonical executable, 정확한 version, argv, protocol, 전달할 environment variable
이름과 capabilities/permission을 먼저 보여 준다. 설치, update 또는 download를 조용히 실행하지 않는다.
서명된 `.ezadapter`는 기존 Ed25519, hash/size, traversal/reparse 방어와 content-addressed 설치 계약을
유지한다.

Claude는 사용자가 설치한 CLI의 기존 authentication chain(OAuth, API key, Bedrock, Vertex,
Foundry)을 그대로 사용한다. Agent SDK에는 검증한 `pathToClaudeCodeExecutable`을 전달하며 subscription
OAuth에는 bare executable name이 아닌 canonical path가 필요하다. EZTerminal은 token을 읽거나 저장하지
않고 embedded login UI를 만들지 않는다. 공개 상용 배포 전에 Anthropic 약관 검토 gate를 통과해야 하며
제품 UI는 `Claude` 또는 `Claude Agent`라고 표기한다.

## 관리형 Agent tree

Host에서 `오케스트레이션 도구 사용`을 한 번 켜면 새로 만들거나 resume한 Agent마다 session-scoped
orchestration MCP를 제공한다. Project별 Collaboration enable/profile/path/limit UI와 별도 run graph는
없다. 관리형 child는 parent와 같은 완전한 Agent session이며 재귀와 cross-provider를 지원한다.

사용자는 child를 직접 열고 대화하며 model/permission 변경, Cancel, Archive와 Detach를 실행할 수 있다.
busy session의 일반 Send는 FIFO queue에 들어가고 `Interrupt + Send`만 현재 turn을 중단한다.

- Cancel: 현재 turn만 cooperative interrupt
- Archive: 실행을 끝낸 뒤 기본 목록에서 숨기고 history는 보존
- Detach: parent edge만 제거하고 top-level session으로 승격, 실행은 유지

parent에는 child transcript를 복사하지 않는다. bounded result summary와 child link를 event로 전달한다.
같은 Workspace child는 자동 open하지 않고 cross-workspace child만 context 전환을 알리기 위해 자동
open할 수 있다. provider-native subagent는 같은 track에 표시하지만 read-only/provider-owned다.

hard cap은 동시 managed turn 4, tree node 16, depth 4, tree당 10분 내 child 생성 12,
background turn 2시간이다. 동시성 초과는 FIFO queue로 수용하고 node/depth/rate/time cap은 구조화된
오류 또는 timeout 상태로 처리한다.

## Schedule, heartbeat와 local control

Schedule은 5-field cron과 IANA timezone을 canonical form으로 저장하며 매 run마다 새 Agent session을
만든다. `--every`는 저장 전에 cron으로 compile한다. missed tick은 backfill하지 않고 max-runs, expiry와
run-now를 지원한다. Heartbeat는 같은 기존 Agent session에 prompt를 보내며 busy면 pending 하나로
coalesce한다.

통합 `ezterminal` CLI는 현재 shell의 Project 범위에서
project/workspace/session/agent/provider/schedule/heartbeat command를 제공한다. Project 생성과
provider enable/update처럼 신뢰 범위를 넓히는 작업은 CLI에서 수행하지 않고 Desktop review
이동 안내를 반환한다. 각 Agent에 제공하는 session-scoped orchestration MCP는 자신과 daemon이
소유를 재검증한 managed descendant의 생성, 조회, follow-up, cancel, archive만 제공하며 Project나
provider를 관리하는 광범위 admin API를 노출하지 않는다. 기존 `ezterminal-agent` entry는 한 major release
동안 compatibility shim으로 유지하고 deprecation 안내 뒤 같은 router를 호출한다.

## Browser, script와 service

Browser session은 기본적으로 꺼져 있고 Desktop host가 있을 때만 실행한다. Workspace별 isolated
partition, `http`/`https` navigation, accessibility snapshot ref, password masking과 workspace 내부
file upload만 허용한다. Android는 live state와 승인/중단을 볼 수 있지만 browser를 host하지 않는다.

Script는 명시적 command/cwd/environment variable 이름으로 실행하는 one-shot session이다. Service는
동일한 입력과 restart policy를 가진 supervised long-running session이다. secret value는 project나
runtime DB에 저장하지 않는다.

## UI와 platform 동등성

Desktop과 Android는 같은 live transcript, child track, 직접 follow-up, approval, stop, archive와
detach 의미를 제공한다. child click은 기존 tab을 재사용하거나 정상 Agent tab을 연다. provider 설치,
browser hosting, service 구성과 고위험 merge override는 Desktop-only이며 Mobile에서 불가능한 control을
disabled affordance로 남기지 않는다.

Desktop quit, daemon restart와 Android reconnect를 거쳐도 prompt가 중복 제출되거나 process가 orphan되지
않아야 한다. 복구할 수 없는 turn은 성공이나 실행 중으로 가장하지 않고 interrupted 또는
delivery-uncertain으로 표시한다. 명시적 Quit은 queued/working/blocked turn과 관련 schedule run을
`explicit-quit`으로 내구적으로 중단하고 approval을 만료시키되, provider history로 resume할 수 있는 Agent
Session 자체는 idle로 남긴다. 이미 delivery-uncertain인 turn은 확정된 실패로 덮어쓰지 않는다.
모든 client는 같은 snapshot revision을 관찰해야 한다. archive된 Agent Session은 기본 live 목록에서
숨기지만 Desktop과 Android의 Archived 뷰에서 transcript와 relation을 read-only history로 다시 열 수
있어야 한다.

## 근거 소스

- [`src/shared/daemon-protocol.ts`](../../src/shared/daemon-protocol.ts)
- [`src/shared/remote-protocol.ts`](../../src/shared/remote-protocol.ts)
- [`src/main/main.ts`](../../src/main/main.ts)
- [`src/main/agent-orchestration-service.ts`](../../src/main/agent-orchestration-service.ts)
- [`src/renderer/AgentHub.tsx`](../../src/renderer/AgentHub.tsx)
- [`mobile/src/MobileAgentView.tsx`](../../mobile/src/MobileAgentView.tsx)

## 검증

- protocol/schema와 SQLite migration 단위 테스트:
  [`daemon-protocol.test.ts`](../../src/shared/daemon-protocol.test.ts)
- provider contract, outbox idempotency와 crash reconciliation 테스트
- ProcessGuardian과 keep-running/login lifecycle OS 테스트
- Desktop/Android component, accessibility와 production Storybook 테스트
- ordinary `pnpm e2e`의 quit/restart/reconnect 및 direct child 대화 시나리오
- packaged Desktop/APK smoke와 release security/SBOM 검사

고정 desktop handoff 원본은 수정하지 않으며 reference와 나란히 검토한 경우에만 snapshot을 갱신한다.
release performance benchmark는 명시적인 성능 측정 요청이 있을 때만 실행한다.
