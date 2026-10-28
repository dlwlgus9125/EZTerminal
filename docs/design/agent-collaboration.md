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

`Agent 실행`은 Terminal CLI를 기본으로 하는 draft다. 앱에서 대화를 선택하면
provider/model, workspace, 첫 prompt와 다음 세 permission preset을 한 화면에서 편집한다.

- `Plan`: 탐색과 계획 중심, 변경 작업은 승인 필요
- `Standard`: 필요할 때 승인을 요청하는 기본값
- `Full access`: 명시적으로 선택한 session에 한해 넓은 권한

앱 대화 provider session과 process는 첫 Send에서만 만든다. Codex 앱 대화는 app-server,
Claude 앱 대화는 Agent SDK의 streaming input으로 실행한다. Terminal CLI의 새 실행과
CLI history resume도 계속 지원하며 SDK 최소 버전·대화 활성화 여부와 분리한다. Terminal은
제품의 기본 세션이며 문맥이 있는 실행은 해당 Workspace를 다시 검증한다.

Agent transcript는 사용자·provider 원문을 표시하고 SQLite에 원문으로 저장한다. 민감 분류는
metadata이며 자동 숨김 조건이 아니다. 진단 로그는 기존 sanitization 경계를 유지한다.
스키마 v4는 optional message_id 열을 추가해 delta와 완료 event의 provider message identity를
재시작 후에도 유지한다. 기존 기록은 그대로 보존하며 이미 삭제된 원문은 복원하지 않는다.

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
직렬화 경계에서 제거한다. 앱 대화 생성은 비활성화하고 UI retry loop를 만들지 않는다.
일반 Terminal과 CLI 실행 진입은 유지한다.

## 구조화 transcript와 승인 상세

schema v7은 `transcript_items.payload_json`, `approvals.request_json`, `agents.reasoning_effort`를
추가한다. migration은 단방향이며 v7 DB는 이전 2.0.0 설치판이 열지 못한다.

- [`src/shared/transcript-payload.ts`](../../src/shared/transcript-payload.ts)의 payload(tool, todo,
  reasoning, plan)는 메타데이터다. 본문은 계속 `text`가 소유한다. 관대한 parser가 실패하면 payload를
  버리고 text만으로 렌더링하므로, 구 host와 payload 이전 대화도 같은 채팅 행으로 해석된다.
- protocol version은 올리지 않고 snapshot capability로 확장한다: `transcript-payload-v1`,
  `approval-request-v1`, `approval-response-v1`, `agent-effort-v1`. client는 `approval-response-v1`이
  있을 때만 `permission.resolve.response`(answers, plan, feedback)를 보낸다.
- 승인 `request`([`approval-request.ts`](../../src/shared/approval-request.ts))는 명령, diff, 질문과
  계획 같은 도구 입력을 64KB 상한으로 담는다. snapshot은 대기 중인 승인에만 request를 노출하므로
  백업 archive에는 포함되지 않는다. 민감도(`isSensitive`)는 메타데이터다. 기록과 미리보기는 민감 행을
  보여 주고, archive는 민감 행의 본문, 첨부와 payload를 비운다. 실행 결과(읽기 전용 단계의 결과 캡처,
  독립 검토 판정, 다음 단계 입력)는 같은 턴의 답변을 민감 표시와 관계없이 쓰며,
  같은 `messageId`의 delta는 답변 하나로 합친다. 명령 실행 결과처럼 민감한 도구 출력은 넣지 않는다.
- Claude는 대화 세션에서 partial message를 스트리밍한다. 두 adapter의 DeltaCoalescer가 delta를 약
  80ms 또는 2KB 단위로 묶어 기록하고, 블록의 최종 메시지가 같은 `messageId`로 delta를 대체한다.
  non-delta row, 승인 요청과 turn 종료 전에는 항상 flush한다.
- 계획 승인 응답의 mode는 agent의 `permissionPreset`을 바꾸고 provider도 같은 mode로 전환한다.
- Desktop은 긴 transcript를 꼬리부터 읽고 이전 페이지는 요청할 때 읽는다. `transcript.appended`는
  snapshot을 다시 읽지 않는다.

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

설정 → 에이전트 → **에이전트 협업**의 `에이전트가 다른 에이전트를 만들 수 있음`(기본 꺼짐)을 켜면 새로
만들거나 resume한 Agent마다 session-scoped orchestration MCP를 제공한다. 같은 구역의 **에이전트 프로필**
(provider·model·reasoning effort·permission·언제 쓰나요, desktop `chat-agent-profiles.json`)은 새 대화의
`프로필` 선택, 대화 메뉴의 맡기기, MCP `list_profiles`/`create_agent{profileId}`가 함께 쓴다. MCP로 만든
child도 profile permission이 호출한 Agent의 permission을 넘을 수 없고, permission을 정하지 않으면 호출한
Agent의 수준을 그대로 쓴다. Project별 Collaboration UI와
별도 run graph는 없다. 이전 협업 경로(Lead run: `ezterminal workers …`·`ezterminal-agent` CLI, 로컬
worker HTTP API, 터미널 pane의 worker strip)는 한 메이저 릴리스 동안 호환용으로만 남아 있다(README).
관리형 child는 parent와 같은 완전한 Agent session이며 재귀와 cross-provider를 지원한다.

사람이 대화 메뉴의 `맡기기…`/`검토 맡기기…`로 만드는 child(desktop·android 주체)는 위 토글이나 parent의
orchestration 표시와 무관하게 만들 수 있다. 관리형 상한과 같은 Project·살아 있는 parent 조건은 같다.
child의 첫 transcript 행이 출처(parent)와 `결과 회신` 여부를 기록한다. 회신을 고른 child는 처음 끝난
turn의 마지막 답(최대 8,000자, 잘리면 표시)을 parent의 다음 메시지로 한 번 보낸다. 이 메시지는 host만
보내는 실제 `agent.submit`(`reportOf`, 주체 `report-back-runtime`)이며 화면에 `서브에이전트가 보낸 결과`로
표시된다. 보낼 수 없으면(parent 종료·provider 비활성) 기존 요약 행으로 남긴다. 검토 맡기기는 기본 회신,
맡기기는 기본 미회신이다.

Agent가 MCP로 띄운 child의 결과는 두 방법으로 받는다. `wait_agent{sessionId, timeoutSeconds}`는 child가
끝나거나 승인을 기다리게 될 때까지(1~240초, 기본 120) 기다렸다가 `read_agent`와 같은 내용(상태, 마지막
turn, 마지막 답 최대 8,000자, 대기 중 승인 제목 최대 5개)을 돌려준다. `needsAttention`이면 사람이 승인한
뒤 다시 기다린다. `create_agent{reportBack: true}`로 만들고 turn을 끝내면 위 회신이 다음 메시지로 온다.
같은 child에 둘을 함께 쓰면 결과가 두 번 오므로 회신을 앞둔 직속 child의 `wait_agent`는 거부한다. 대상은
관리형 후손뿐이고 호출자당 동시 대기는 8개다. 두 provider의 MCP 도구 시간 제한은 300초로 둔다(Claude
`timeout`, Codex `tool_timeout_sec`).

`create_worktree{branch}`는 호출자의 Project에 새 branch의 worktree를 만들어 `workspaceId`와 폴더를
돌려준다. 메인 checkout의 현재 commit에서 시작하고 커밋 안 된 변경은 옮기지 않으며 호출자 자신의 작업
위치는 바뀌지 않는다. Plan permission Agent에는 없고 Project당 열린 워크트리(기획 실행 소유 제외)는 16개까지다.
`create_agent{workspaceId}`는 같은 Project의 활성 작업 위치(기획 실행 소유 제외)에 child를 띄운다. 병합과
정리는 사람이 한다.

사용자는 child를 직접 열고 대화하며 model/permission 변경, Cancel, Archive와 Detach를 실행할 수 있다.
busy session의 일반 Send는 FIFO queue에 들어가고 `Interrupt + Send`만 현재 turn을 중단한다.

- Cancel: 현재 turn만 cooperative interrupt
- Archive: 실행을 끝낸 뒤 기본 목록에서 숨기고 history는 보존
- Detach: parent edge만 제거하고 top-level session으로 승격, 실행은 유지

parent에는 child transcript를 복사하지 않는다. bounded result summary(child의 그 turn 마지막 답, 없으면
provider 요약)와 child link를 event로 전달한다. 같은 Workspace child는 자동 open하지 않고
cross-workspace child만 context 전환을 알리기 위해 자동 open할 수 있다.

provider-native subagent(Claude Agent tool의 `local_agent`, Codex sub-agent thread)는 토글과 무관하게
child 대화로 기록한다. 지시·도구·결과는 child에만 쌓이고 parent에는 시작 link와 최종 요약 한 번만
남는다. child 안의 승인은 parent 승인 독에 `서브에이전트 ○○ 요청`으로 표시된다. 백그라운드 셸·MCP
작업은 서브에이전트가 아니다. 목록(프로젝트 대화 탭·이전 대화·검색·최근순·모바일)은 child를 따로
보이지 않고 트리에서 parent 아래 접는다. read-only/provider-owned다.

hard cap은 동시 managed turn 4, tree node 16, depth 4, tree당 10분 내 child 생성 12다.
대화 turn에는 경과 시간 제한이 없다. 사람이 멈추거나 AI가 끝낼 때까지 실행한다(2026-10-20, 2시간 제한 제거).
Lead 위임 사이클(Lead run)에도 경과 시간 제한이 없다. 사이클은 stop·complete·Lead session 종료·앱 재시작에서만
끝나며 작업자 생성 수와 동시 실행 수 한도는 그대로다. 저장 형식의 `maxDurationMs`·`expiresAt`는 기존 정책
파일과 구형 APK 호환을 위해 남기지만 읽지 않는다(2026-10-21, 2시간 제한 제거).
provider-native child는 host가 예약하는 작업이 아니라 기록이므로 별도로
루트 대화당 100개, depth 8까지 기록한다. 동시성 초과는 FIFO queue로 수용하고 node/depth/rate cap은 구조화된
오류로 처리한다.

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

새 Agent의 첫 Send는 client에서도 복구 가능한 전송 경계다. Android는 exact idempotent
`agent.create` 한 건을 Keystore-backed secure storage에 쓰고 동일 값 read-back을 확인한 뒤에만
WebSocket으로 전송한다. 안전 저장소를 확인할 수 없으면 plaintext로 대체하지 않고 Agent 생성만
fail closed하며 Terminal은 유지한다. 레코드와 secure-storage key는 인증에 사용된 bearer의
domain-separated SHA-256 fingerprint별로 분리한다. raw bearer는 복구 레코드에 저장하지 않으며 다른
Desktop authority에서 만든 command를 현재 연결로 재전송하지 않는다. 앱 재시작은 현재 인증 authority와
일치하는 저장 command에서만 잠긴 draft를 재구성하고 fresh snapshot으로 기존 session을 먼저 대조한 뒤
같은 command만 재전송한다. 일시적인 secure-storage 오류는 화면의 명시적 Retry로 다시 확인할 수 있고,
현재 authority의 레코드가 영구적으로 손상되면 중복 가능성을 설명하는 확인 대화상자를 거친 명시적
폐기만 허용한다. 암호문을 해독할 수 없는 경우에도 이 명시적 폐기는 먼저 복호화를 시도하지 않고 해당
authority의 raw secure-storage key만 제거한다. definitively settled command만 자동으로 저장소에서 제거한다. Desktop은 첫 prompt를
layout 파일에 넣지 않고 main-process memory-only renderer
checkpoint에 exact command를 확인 저장한 뒤 전송한다. 미확정 create는 그 main process가 살아 있는 동안
일반 renderer checkpoint TTL로 만료되지 않고 한 번만 복구되거나 명시적으로 clear된다. 미확정 command가
있는 pane, quit-on-close 창, auxiliary window, workspace preset 교체는 복구 경로를 잃지 않도록 차단한다.
명시적 앱 종료는 Cancel을 기본값으로 유지하면서 메모리 복구 정보의 폐기와 다음 실행의 중복 생성 위험을
함께 경고한다. 메모리 checkpoint의 동시 미확정 create 상한은 64개이며, 상한을 넘는 새 create는 기존
레코드를 잘라내지 않고 persistence와 daemon 전송 전에 fail closed한다.

Desktop 채팅·워크플로 초안은 Electron safeStorage(Windows DPAPI 사용자 범위)로 암호화해
user data의 전용 디렉터리(`chat-state`, `workflow-drafts`)에 저장한다(옛 기획 초안 `planning-drafts`는 I5에서
기획 패널과 함께 없앴다). Windows에서는
그 디렉터리에 현재 사용자와 SYSTEM만 허용하는 보호·상속 DACL을 시작 시 한 번 적용·검증하고, 안에서 만든
파일은 이를 상속한다. 입력 중 저장마다 PowerShell로 파일 DACL을 다시 검증하지 않는 대신 디렉터리 DACL이
다른 principal의 파일 생성·교체를 막고, 내용은 DPAPI 암호문으로 기밀성과 무결성을 지킨다. 원격 토큰 등
다른 비밀은 파일별 DACL 검증을 유지하며 `guard:secure-storage`가 이 경계를 고정한다.

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
