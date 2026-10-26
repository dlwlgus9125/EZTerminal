# ux2 진입점 통합표

현재 제품(main `f958e5a`)에서 같은 기능에 닿는 진입점을 모두 적고, 개편 뒤 어디로 모이는지 정한다.
"목표 소유 화면"은 [`frontend-design.md`](../frontend-design.md)의 목표 IA 이름이며, 대화 목록의 주인처럼
관문 ①에서 사용자가 고르는 축은 **D①-n**으로 표시했다. "묶음"은 실제로 바뀌는 시점(②=새 셸, B1–B5=관문 ③
흐름 묶음)이다. "거치는 테스트"는 그 진입점이 바뀔 때 다시 써야 하는 테스트다.

- 출처: Claude 조사 에이전트와 Codex gpt-6-astra(xhigh)가 각자 만든 인벤토리를 교차 검증해 합쳤다(§16).
- 경로 약어: `R/` = `src/renderer/`, `M/` = `mobile/src/`. 테스트 약어: `e2e/x` = `e2e/x.spec.ts`,
  `me2e/x` = `mobile/e2e/x.ts`, `vis/x` = `visual/x.spec.ts`, `pkg/x` = `e2e-packaged/x.spec.ts`,
  `u:` = 단위 테스트 파일.
- 처리: **표준**(이것으로 모은다) · **대체**(같은 자리에 새 동작) · **재연결**(같은 함수 호출로 바꿈) ·
  **이동** · **삭제**.

## 요약

| 기능 | 현재 | 목표 |
|---|---|---|
| 새 대화 시작 | 진입점 약 30곳(데스크톱·Android), 생성 화면 3종(초안 탭·모달 폼·위임 대화상자) + 옛 폼 fallback 2종, 라벨 6종 이상 | 모든 진입점이 `openConversationDraft(seed)` 하나를 호출, 생성 화면 1종(초안 탭/페이지), 라벨 "새 대화" 1종. 위임은 같은 입력창의 위임 시트 |
| 대화 목록 | 사이드바 트리, 프로젝트 페이지 목록, 옛 기획 대화 탭, 받은 요청, 기록 대화상자, CLI 기록 하위 화면, Android 3종 | 주인 1곳(D①-1), 나머지는 개수·링크만 |
| 이전 기록 | 기록 대화상자 진입 6곳 + CLI 기록 하위 화면 + `/resume` | 대화 목록의 "기록" 범위 하나 |
| 프로젝트 | 프로젝트 페이지(도크) + Project Explorer(사이드바를 교체) + 프로젝트 편집(사이드바 대화상자) | 프로젝트 홈 탭 하나 + 파일 목적지 |
| 소프로젝트 실행 | 캔버스 run bar + 옛 `PlanningExecutionPanel` | 캔버스 run bar + 실행 서랍 하나 |
| AI 프로필 | 대화 프로필, 기획 역할 프로필, 단계별 AI, 리뷰어, 실행 작업자, 일반 CLI 프로필 | 설정 → AI의 목록 하나 + 어디서나 같은 picker |
| 변경 검토·diff | 15경로(결과 탭, 대화상자 오버레이, 편집기 diff, git-diff 대화상자, 관리 머지, 워크트리 병합…) | 결과 탭 하나(범위 표시) + 파일 탭의 diff 모드 |
| 파일 보기 | 오버레이, 편집기 탭, 결과 탭 파일, Android 페이지 | 파일 탭 하나(Android는 같은 컴포넌트의 페이지) |
| 받은 요청 수 | 공식 3종(헤더·레일/상태줄·Android) | host가 계산한 1종 |
| 원격 켜기 | 설정 → 연동에만 스위치, 페어링 카드는 안내만 | 원격 화면 맨 위 스위치(같은 설정 키) |
| 이름 | 워크스페이스/작업영역/작업 공간/작업 위치/작업 폴더/Workspace(번역 안 됨) 혼용 | 용어 사전 1벌(D①-3) |

## 1. 새 대화 시작

| id | 현재 진입점 | 라벨 ko / en | 여는 것 | 목표 | 처리 | 묶음 | 거치는 테스트 |
|---|---|---|---|---|---|---|---|
| 1.01 | 헤더 로봇 아이콘 `R/workbench/AppHeader.tsx:103` | Agent 실행 / Start Agent | 프로젝트 없는 초안 탭 | 타이틀바 **새 대화**(seed: 현재 프로젝트) | 대체 | ②(자리)·B1(seed) | vis/session-navigation |
| 1.02 | 사이드바 하단 `R/AgentHub.tsx:1634` | 새 대화 / New conversation | 프로젝트 없는 초안 탭 | 대화 목록 위 **새 대화** | 재연결 | B1 | e2e/agent-results, conversation-folders, power-save, structured-agent-draft; pkg/conversation-restart; u:AgentHub |
| 1.03 | 트리 프로젝트 행 아이콘 `R/AgentHub.tsx:1480` | 새 채팅: {프로젝트} / New chat | 프로젝트 초안 탭 | 행의 **새 대화**(seed: 프로젝트) | 재연결·라벨 | B1 | 없음 |
| 1.04 | 프로젝트 ⋯ 새 워크트리… `R/AgentHub.tsx:1486` | 새 워크트리… → 만들고 새 대화 | 워크트리 생성 대화상자 → 초안 | 새 대화 ▾ **워크트리에서 새 대화** | 이동 | B1·B2 | 없음 |
| 1.05 | 워크트리 행 `R/ProjectConversationNavigator.tsx:112` | 이 작업 위치에서 새 대화 / New chat here | 작업 폴더 초안 | 행의 **새 대화**(seed: 작업 폴더) | 재연결·라벨 | B1 | u:ProjectConversationNavigator |
| 1.06 | Project Explorer 헤더 `R/ProjectWorkspacePanel.tsx:746` | Agent 실행 / Start Agent | 작업 폴더 초안 | 삭제(Project Explorer의 사이드바 교체를 없앰) | 삭제 | B2 | 없음 |
| 1.07 | 프로젝트 페이지 `R/workflow/WorkflowWorkspacePanel.tsx:372` | 새 일반 대화 / New conversation | 초안 탭(콜백 없으면 모달) | 프로젝트 홈 **새 대화** | 재연결·라벨 | B3 | e2e/workflow-conversation; u:WorkflowWorkspacePanel |
| 1.08 | 옛 기획 헤더 `R/PlanningWorkspacePanel.tsx:941` | 새 대화 | 초안(데스크톱은 숨김, Android 노출) | 삭제(옛 기획 자료 처리 D①-5) | 삭제 | B3 | 없음 |
| 1.09 | 옛 기획 대화 탭 `R/PlanningWorkspacePanel.tsx:1563,1611` | 새 대화 | 초안 | 삭제(D①-5) | 삭제 | B3 | 없음 |
| 1.10 | 단계 대화 `R/workflow/WorkflowNodeSections.tsx:20` | 새 단계 대화 / New stage conversation | 모달 폼(1.13) → 생성 + 단계 연결 | 초안 + **연결 칩(단계)** | 대체 | B3 | u:WorkflowWorkspacePanel |
| 1.11 | 소프로젝트 헤더 `R/workflow/WorkflowWorkspacePanel.tsx:362` | AI와 흐름 편집 / Edit flow with AI | 모달 폼(흐름 편집) | 초안 + 연결 칩(흐름 편집), 캔버스 옆 분할 | 대체 | B3 | 없음 |
| 1.12 | 새 소프로젝트 → 대화로 구성 `R/workflow/WorkflowWorkspacePanel.tsx:406-412` | 구성 대화 열기 / 이어가기 | 모달 폼 또는 기존 대화 | 초안 + 연결 칩(구성) | 대체 | B3 | e2e/workflow-conversation |
| 1.13 | **생성 UI B: 모달 폼** `R/workflow/WorkflowWorkspacePanel.tsx:422` | 흐름 편집 대화 / 새 단계 대화 / 새 일반 대화 | provider·모델·작업 폴더·권한 폼 대화상자 | 삭제(연결 의도는 초안이 가짐, D①-4) | 삭제 | B3 | e2e/workflow-conversation; u:WorkflowWorkspacePanel |
| 1.14 | **생성 UI A: 초안 탭** `R/ConversationStartPanel.tsx:299` | 새 대화 / 첫 메시지를 입력하세요 | 첫 전송이 세션을 만들고 같은 탭이 이어짐 | **표준**(유일한 생성 화면) | 표준 | B1 | e2e/agent-history, agent-results, conversation-folders, power-save, structured-agent-draft, workflow-conversation; me2e/conversation-journey, planning-workflow; pkg/conversation-restart, project-history-navigation; u:conversation-start |
| 1.15 | **생성 UI C: 위임** `R/StructuredAgentSession.tsx:2464` → `R/DelegateAgentDialog.tsx` | 맡기기… / Hand off… | 별도 폼 대화상자, 탭 안 열림 | 같은 입력창의 **위임 시트**(동사 "위임") | 대체 | B1 | u:StructuredAgentDockPanel |
| 1.16 | 검토 맡기기 `R/StructuredAgentSession.tsx:2467` | 검토 맡기기… | 같은 대화상자(review) | 위임 시트(검토 모드) | 대체 | B1 | u:StructuredAgentDockPanel |
| 1.17 | `/new` `R/StructuredAgentSession.tsx:2137` | 이 프로젝트에서 새 대화 시작 | 초안 탭(데스크톱 live만) | 유지(같은 함수), Android에도 | 재연결 | B1 | u:StructuredAgentSession(.keys) |
| 1.18 | `/clear` `R/StructuredAgentSession.tsx:2140` | 이 탭에서 같은 설정으로 새로 시작 | 같은 탭을 초안으로 교체 | 유지 | — | B1 | u:StructuredAgentSession(.keys); e2e/agent-history, structured-agent-draft |
| 1.19 | Command Center 에이전트 행 `R/useCommandCenterCatalog.ts:427` | {name} 실행 / Launch {name} | 활성 터미널에 CLI 명령 삽입 | 유지하되 라벨을 "터미널에서 {name} 실행"으로 구분 + **새 대화 명령 추가** | 대체·추가 | B1 | 없음 |
| 1.20 | 옛 폼 fallback 1 `R/StructuredAgentDockPanel.tsx:948` | 새 세션 / 터미널 열기 | `NewSessionDraftPanel` | 삭제(안전 모드는 최소 목록·열기만) | 삭제 | B1 | e2e/structured-agent-draft; vis/session-navigation; u:NewSessionDraftPanel |
| 1.21 | 옛 폼 fallback 2 `R/StructuredAgentDockPanel.tsx:975` | 새 Agent 세션 / Agent 만들기 | `StructuredAgentDraftPanel` | 삭제 | 삭제 | B1 | u:StructuredAgentDockPanel |
| 1.22 | 초안의 옛 AI·작업 위치 선택 `R/ConversationStartPanel.tsx:277-284` | AI · 대화 AI; 작업 위치 · 대화 작업 위치 | Android에서만 표시 | Android도 입력창 칩 | 대체 | B1 | e2e/conversation-folders(없음을 단언) |
| 1.23 | Project Map 만들기·갱신 `R/ProjectMapPanel.tsx:927,1032` | 새 Agent 세션에서 만들기·갱신 | 터미널 탭에서 CLI 에이전트 실행(`R/App.tsx:2026` → `openTerminal`) | 유지(대화 아님), 라벨을 "터미널에서" 기준으로 | 라벨 | B5 | e2e/project-map-agent-session; u:ProjectMapPanel |
| 1.24 | Android 대화 헤더 + `M/MobileAgentView.tsx:1590` | Agent 실행 / Start Agent | 초안 페이지(복구 시 `MobileNewSessionDraft`) | 대화 목록의 **새 대화** | 재연결·라벨 | B1 | me2e/conversation-journey; u:MobileAgentView, MobileWorkspace |
| 1.25 | Android 프로젝트 페이지 `R/workflow/WorkflowWorkspacePanel.tsx:372` via `M/MobilePlanningNavigator.tsx:113` | 새 일반 대화 | 대화 탭 새 페이지 | 프로젝트 홈 새 대화 | 재연결 | B3 | me2e/planning-workflow |
| 1.26 | Android 옛 기획 헤더·대화 탭 | 새 대화 | 대화 탭 새 페이지 | 삭제(D①-5) | 삭제 | B3 | 없음 |
| 1.27 | Android 기획 내비게이터 행 `M/MobilePlanningNavigator.tsx:154` | 새 대화 / New chat | 프로젝트 선택 + 초안 | 행의 새 대화(같은 함수) | 재연결 | B3 | me2e/planning-workflow |
| 1.28 | Android 단계·흐름 모달 | 1.13과 같음 | 모바일 대화상자 | 초안 + 연결 칩 | 대체 | B3 | 없음 |
| 1.29 | Android 휴면 `M/MobileDaemonNavigator.tsx:359` | Agent 실행: {작업 공간} | 비평면 모드에서만(운영에서는 도달 불가) | 삭제 | 삭제 | B5 | 없음 |
| 1.30 | Android 새 터미널 `M/MobileWorkspace.tsx:1198,1217`, `M/MobileSessionSheet.tsx:73`, `M/SessionSwitcher.tsx:252` | 새 탭 / 새 세션 | 터미널 탭 | 유지(대화 아님), 라벨 "새 터미널" | 라벨 | B5 | me2e/lib, parity, release-soak, session-heavy-output-resume; u:MobileWorkspace |
| 1.31 | 옛 프로젝트 카드·launch picker `R/AgentHub.tsx:1560,1700` | Agent 실행 / 새 프로젝트 세션 | 안전 모드·트리 없는 fallback | 삭제(안전 모드 최소 목록만) | 삭제 | B5 | u:AgentHub |
| 1.32 | Android 미사용 화면 `M/MobileAgentProjects.tsx`, `M/MobileHomeView.tsx`, 초안 컴포넌트 | Agent 실행 | 마운트되지 않음 | 삭제(테스트의 오래된 `mobile-home-view` 대기도 정리) | 삭제 | B5 | me2e/apk-stabilization, parity(오래된 대기) |

## 2. 대화 목록

| id | 현재 | 여는 것 | 목표 | 처리 | 묶음 | 거치는 테스트 |
|---|---|---|---|---|---|---|
| 2.01 | 데스크톱 사이드바 트리 `R/ProjectConversationTree.tsx` (프로젝트별/최근순/보관 포함/검색) | 대화 탭, 프로젝트 행은 프로젝트 페이지 | **대화 목록의 주인 후보**: A안 프로젝트 트리 / B안 대화 목적지(D①-1) | 표준 | B1 | e2e/agent-history, structured-agent-draft, agent-activity-lifecycle (+ `agent-project-open-*` 8개 spec); pkg/project-history-navigation; u:ProjectConversationTree, ProjectConversationNavigator |
| 2.02 | 안전 모드 목록 `R/DaemonAgentSessions.tsx` | 프로젝트 열기, 터미널(테스트 id `agent-project-new-chat-*`가 터미널을 엶) | 안전 모드 최소 목록으로 축소, 오해 소지 테스트 id 정리 | 축소 | B5 | u:DaemonAgentSessions, AgentHub |
| 2.03 | 프로젝트 페이지 목록 `R/workflow/WorkflowWorkspacePanel.tsx:369-375` | 대화 탭 | 프로젝트 홈에는 "대화 N개 →" 링크만(목록 주인으로 이동) | 축소 | B3 | e2e/workflow-conversation, subproject-workflow, workflow-canvas-run, planning-workflow, project-workbench, project-map-agent-session, agent-experience; me2e/planning-workflow; u:WorkflowWorkspacePanel |
| 2.04 | 옛 기획 대화 탭 `R/PlanningWorkspacePanel.tsx:1560` | 대화 탭 | 삭제(D①-5) | 삭제 | B3 | u:PlanningWorkspacePanel |
| 2.05–2.07 | 소프로젝트 ⋯·단계 패널·실행 단계의 대화 열기 `R/workflow/*` | 대화 탭 | 노드·실행의 **연결된 대화 칩**(목록 아님) | 유지 | B3 | e2e/subproject-workflow, workflow-conversation, workflow-canvas-run |
| 2.08 | 받은 요청 `R/AgentHub.tsx:1295`, `R/AppChatInbox.tsx` | 대화 탭, 승인 | **확인할 일**의 요청 행(대화 목록 아님, D①-8) | 대체 | B1 | e2e/agent-activity-lifecycle; u:AgentHub |
| 2.09 | CLI 기록 하위 화면 `R/AgentHub.tsx:1122` | 사이드바 본문 교체 | 대화 목록의 **기록** 범위 | 삭제·흡수 | B1 | e2e/agent-history; u:AgentHub |
| 2.10 | 기록 대화상자 `R/ConversationHistoryPicker.tsx` | 모달(데스크톱은 선택만, "CLI에서 이어가기" 도달 불가) | 기록 범위로 흡수 | 삭제·흡수 | B1 | e2e/structured-agent-draft; pkg/project-history-navigation; u:ConversationHistoryPicker |
| 2.11 | Ctrl+Tab 전환기 `R/RecentPanelSwitcher.tsx` | 열린 패널 | 유지(목록 아님) | 유지 | — | e2e/recent-panel-switcher, popout-interaction-parity |
| 2.12 | Android 프로젝트·작업 트리 `M/MobilePlanningNavigator.tsx` | 대화·프로젝트 페이지 | Android 프로젝트 탭(프로젝트+작업 통합) | 통합 | B3 | me2e/planning-workflow, subagent-tree; u:MobileWorkspace |
| 2.13 | Android 대화 평면 목록 `M/MobileDaemonNavigator.tsx:295` | 대화 페이지 | Android 대화 목록(데스크톱과 같은 모델) | 표준 | B1 | u:MobileAgentView, MobileDaemonNavigator |
| 2.14 | Android 주의·관리 머지 카드 `M/MobileAgentView.tsx:1605` | 인라인 카드 | 확인할 일 탭 | 이동 | B1 | vis/storybook; u:MobileAgentView |
| 2.15 | Android 기록 시트 `M/MobileAgentView.tsx:1319` | 전체 화면 시트 | 기록 범위 | 흡수 | B1 | me2e/conversation-journey; u:MobileAgentView |

## 3. 이전 기록

| id | 현재 | 목표 | 처리 | 묶음 | 거치는 테스트 |
|---|---|---|---|---|---|
| 3.01–3.04 | 기록 대화상자 진입: 사이드바 제목 `R/AgentHub.tsx:1419`, 프로젝트 ⋯ `:1483`, 대화 ⋯ `R/StructuredAgentSession.tsx:2451`, 초안 폼 버튼 `:731` | 대화 목록 기록 범위로 이동(대화 ⋯에서는 "이 프로젝트 기록 보기") | 재연결 | B1 | e2e/structured-agent-draft; u:WorkflowWorkspacePanel |
| 3.05 | `/resume` `R/agent-completion.ts:43` | 기록 범위 열기 | 재연결 | B1 | u:StructuredAgentSession, agent-completion |
| 3.06 | 대화상자 동작(대화 열기 / Agent로 이어가기 / CLI에서 이어가기) | 기록 행의 동작으로(데스크톱에서도 "CLI에서 이어가기" 도달 가능) | 흡수 | B1 | pkg/project-history-navigation; u:ConversationHistoryPicker |
| 3.07 | 트리 대화 행 | 대화 탭 열기(그대로) | 유지 | B1 | e2e/agent-history, structured-agent-draft |
| 3.08 | CLI 기록 열기 `R/AgentHub.tsx:1484` | 기록 범위의 출처 필터(EZ / Claude CLI / Codex CLI) | 흡수 | B1 | e2e/agent-history |
| 3.09 | 터미널에서 이어가기 `R/ConversationStartPanel.tsx:334` | 대화 ⋯의 명시 동작(유지) | 유지 | B1 | e2e/agent-history |
| 3.10–3.14 | Android 기록 진입(대화 헤더, 세션·초안, 프로젝트 페이지, 세션 없는 트리 행, CLI 재개 시트) | Android 대화 목록 기록 범위 | 흡수 | B1 | me2e/conversation-journey; u:MobileAgentView |

## 4. 프로젝트

| id | 현재 | 목표 | 처리 | 묶음 | 거치는 테스트 |
|---|---|---|---|---|---|
| 4.01–4.03 | 트리 프로젝트 행·⋯ 소프로젝트 만들기·안전 모드 행 → 프로젝트 페이지 도크 탭 | **프로젝트 홈 탭** | 대체 | B3 | e2e/agent-experience, planning-workflow, project-map-agent-session, project-workbench, subproject-workflow, workflow-canvas-run, workflow-conversation |
| 4.04 | 이 단계로 돌아가기 | 소프로젝트 탭의 그 단계 | 재연결 | B3 | e2e/workflow-conversation; me2e/planning-workflow |
| 4.05 | 프로젝트 페이지 뒤로(목록으로) | 탭 구조에서는 불필요(뒤로 대신 목록 주인으로 이동) | 삭제 | B3 | e2e/workflow-conversation |
| 4.06–4.09 | Project Explorer(사이드바 본문 교체): 프로젝트 ⋯ 프로젝트 파일, 옛 기획 "파일", 결과물 "프로젝트 파일 열기", 변경 검토 "현재 프로젝트 파일 열기" | **파일 목적지**(루트: 프로젝트 먼저) + 파일 탭 | 이동 | B2 | e2e/project-workbench, project-map-agent-session |
| 4.10 | Project Explorer 헤더(뒤로, 새 터미널, Agent 실행, Project Map, 관리) | 프로젝트 홈의 동작으로 | 이동 | B2·B3 | e2e/project-map-agent-session; u:ProjectWorkspacePanel |
| 4.11 | 작업 위치 선택 `R/ProjectWorkspacePanel.tsx:775` | 파일 목적지의 루트·작업 폴더 전환 | 이동 | B2 | e2e/project-workbench |
| 4.12–4.13 | 입력창 "프로젝트 편집…", 프로젝트 ⋯ 프로젝트 편집 → 사이드바 대화상자 | 편집 대화상자만(사이드바 없이), 판 머리 프로젝트 설정·모든 프로젝트 ⋯ 편집과 같은 화면 — P-1(2026-10-26) | 이동 | B3 | e2e/conversation-folders, project-dialogs; u:ProjectDialogs |
| 4.14–4.16 | 프로젝트 추가·고정·삭제·새 터미널 | 추가 = 위 막대 `+` 대화상자, 고정·삭제 = 모든 프로젝트 대화상자, 새 터미널 = 판 — P-1(2026-10-26) | 이동 | B1·B3 | e2e/project-dialogs, project-workbench, structured-agent-draft; u:AllProjectsDialog, ProjectDialogHost |
| 4.17–4.18 | Android 프로젝트 페이지·파일 | Android 프로젝트 탭, 파일(더보기 또는 프로젝트 홈) | 통합 | B3·B2 | me2e/planning-workflow, apk-stabilization, parity |

## 5. 소프로젝트 실행

| id | 현재 | 목표 | 처리 | 묶음 | 거치는 테스트 |
|---|---|---|---|---|---|
| 5.01–5.03 | 캔버스 실행 준비 → 준비 대화상자 → run bar(시작·일시정지·재개·취소·통합 허용·승인 대기) | **실행 → 설정 확인·시작** 한 사용자 작업 + run bar | 대체 | B3 | e2e/workflow-canvas-run; vis/storybook |
| 5.04 | 캔버스 "결과·검토·통합" → 옛 기획 화면의 두 번째 실행 UI | 소프로젝트 탭의 **실행 서랍**(단계 상태·로그·승인·결과·통합) | 대체 | B3 | 없음 |
| 5.05 | 단계 실행 상태 탭(작업·검토 대화, 결과 상세) | 실행 서랍과 노드 패널 | 유지·정리 | B3 | e2e/workflow-canvas-run |
| 5.06–5.07 | 프로젝트 보기 전환 "빠른 작업·기존 자료", 소프로젝트 탭 흐름/변경 기록/기획·설계·검토 | 소프로젝트 탭 흐름 / 문서 / 기록, 옛 자료는 D①-5 | 정리 | B3 | e2e/planning-workflow, project-workbench, project-map-agent-session; me2e/planning-workflow |
| 5.08 | **옛 `PlanningExecutionPanel`** | 삭제(기능은 실행 서랍으로) | 삭제 | B3 | u:PlanningExecutionPanel |

## 6. AI 프로필

| id | 현재 | 목표 | 처리 | 묶음 | 거치는 테스트 |
|---|---|---|---|---|---|
| 6.01–6.02, 6.05, 6.07 | 설정 → 에이전트, 에이전트 프로필, 사이드바 "에이전트 설정", "AI 설정 열기" | **설정 → AI** 프로필 목록 하나 | 표준 | B3 | e2e/structured-agent-draft; u:ChatAgentCollaborationSettings |
| 6.03 | 일반 CLI 프로필(Command Center 에이전트 행) | 설정 → AI → CLI 실행기(대화 프로필과 구분) | 정리 | B3 | 없음 |
| 6.04 | 앱에서 대화(provider 켜기) | 설정 → AI | 이동 | B3 | e2e/structured-agent-draft; u:StructuredProviderSettings |
| 6.06 | 초안의 프로필 선택(입력창 위) | 입력창 칩의 AI 프로필 | 대체 | B1 | 없음 |
| 6.08 | 입력창 pill(계획·모델·강도·권한·작업 위치) | 유지(칩 문법 통일) | 유지 | ②·B1 | e2e/structured-agent-draft, agent-results, conversation-folders; u:StructuredAgentSession(.plan), StructuredAgentDockPanel.wiring, MobileAgentView |
| 6.09 | 옛 초안 폼 선택(ko에서 영어 Provider/Workspace/Model) | 삭제(1.13·1.20·1.21과 함께) | 삭제 | B1·B3 | vis/session-navigation; u:StructuredAgentDockPanel |
| 6.10 | 위임 프로필 선택 | 위임 시트의 같은 picker | 재연결 | B1 | u:StructuredAgentDockPanel |
| 6.11–6.13 | 기획 역할 프로필·기본 역할 프로필·실행 작업자 | 같은 picker(저장 모델 통합은 필요 입증 시만, 실행 snapshot 전체 보존) | 재연결 | B3 | u:PlanningWorkspacePanel, PlanningExecutionPanel |
| 6.14–6.15 | 단계별 AI(캔버스), 독립 검토 AI | 같은 picker | 재연결 | B3 | e2e/workflow-canvas-run |
| 6.16 | 옛 CLI launch picker | 삭제(1.31) | 삭제 | B5 | u:AgentHub |

## 7. 변경 검토·diff

| id | 현재 | 목표 | 처리 | 묶음 | 거치는 테스트 |
|---|---|---|---|---|---|
| 7.01–7.04 | 대화 헤더 결과물, 결과 탭(변경 내역/파일/계획·작업), 턴 변경 요약, 작업 도크 | **결과 탭**(범위: 이번 응답 / 대화 / 작업 폴더 / 실행 단계) | 표준 | B2 | e2e/agent-results; vis/storybook; u:StructuredAgentSession |
| 7.05 | 결과 탭이 없을 때의 변경 검토 대화상자·Android 시트 | 결과 탭(Android는 같은 컴포넌트의 페이지) | 대체 | B2 | u:StructuredAgentSession, MobileConversationReviewProvider |
| 7.06–7.07 | Project Explorer 인라인 diff, 기록의 변경 파일 검토 | 파일 탭의 diff 모드 | 이동 | B2 | e2e/project-workbench, agent-history; u:ProjectEditorPanel |
| 7.08–7.12 | CLI 기록 행·받은 요청 "diff 보기"·워크트리 행 "변경 검토"·git-diff 대화상자·관리 머지 검토 | 결과 탭(작업 폴더·병합 범위) | 대체 | B2 | u:AgentHub |
| 7.13 | 워크트리 병합 대화상자 | 유지(병합은 별도 결정), "변경 검토 열기"는 결과 탭으로 | 재연결 | B2 | u:ProjectConversationNavigator |
| 7.14 | 터미널 변경 요약 링크 | 파일 탭 diff | 재연결 | B2 | e2e/project-workbench |
| 7.15 | Android "diff 보기" | 결과 페이지 | 대체 | B2 | u:MobileAgentView |

## 8. 파일 보기

| id | 현재 | 목표 | 처리 | 묶음 | 거치는 테스트 |
|---|---|---|---|---|---|
| 8.01 | 탐색기 사이드바 → 전체 화면 오버레이 `RichFileViewerOverlay` | 파일 목적지 → **파일 탭** | 대체 | B2 | e2e/file-explorer, workbench-shell; u:FileExplorerPanel, RichFileViewerOverlay |
| 8.02–8.03 | Command Center 파일 행, 터미널 파일 링크(등록 프로젝트면 편집기 탭, 아니면 오버레이) | 파일 탭 하나 | 대체 | B2 | e2e/project-workbench |
| 8.04–8.05 | Project Explorer 트리·Project Map 근거 → `project-editor` 탭 | 파일 탭(같은 구현) | 표준 | B2 | e2e/project-workbench, agent-history; vis/storybook; u:ProjectEditorPanel |
| 8.06 | 결과 탭 파일(인라인 미리보기, 브라우저로 열기) | 결과 탭 안 유지 + "파일 탭에서 열기" | 유지 | B2 | e2e/agent-results |
| 8.07–8.08 | Android 파일 페이지·터미널 경로 미리보기 | 같은 파일 보기 컴포넌트의 페이지 | 통합 | B2 | me2e/parity, apk-stabilization; u:MobileFileView |

## 9. 받은 요청과 주의 수

| id | 현재 | 수 계산 | 목표 | 처리 | 묶음 | 거치는 테스트 |
|---|---|---|---|---|---|---|
| 9.01 | 헤더 에이전트 알림 `R/workbench/AppHeader.tsx:169` | max(주의+받은 요청, 읽지 않음) `R/App.tsx:3088` | 삭제(레일 배지 하나) | 삭제 | ② | e2e/workbench-shell; vis/session-navigation, storybook |
| 9.02 | 레일 받은 요청 `R/workbench/ActivityRail.tsx:72` | 주의 + 받은 요청 `R/App.tsx:1535` | 확인할 일 목적지, **host 계산 수 1종**(D①-8) | 표준 | ②(자리)·B1(수) | 없음(받은 요청을 여는 e2e가 없음) |
| 9.03 | 상태 표시줄 대기 수 | 9.02와 같음 | 삭제(상태줄은 연결·효과·언어만) | 삭제 | ② | 없음 |
| 9.04 | 사이드바 제목·추적 수 | — | 목록 주인 제목 | 정리 | ② | — |
| 9.05 | Android 대화 탭 배지 | 주의만(받은 요청 제외) | 확인할 일 탭, 같은 수 | 대체 | ②·B1 | me2e/conversation-journey; u:MobileWorkspace |
| 9.06 | Android 대화 헤더 대기 문장·필터 | — | 확인할 일 탭 | 이동 | B1 | u:MobileAgentView |
| 9.07 | OS 알림 → 대화 탭 | — | 유지(요청 위치로) | 유지 | B1 | 없음 |

## 10. 원격 켜기와 페어링

| id | 현재 | 목표 | 처리 | 묶음 | 거치는 테스트 |
|---|---|---|---|---|---|
| 10.01 | 설정 → 연동 원격 접속 스위치·다시 시도 | 원격 화면 맨 위 스위치와 같은 키(설정에도 유지) | 추가 | B4 | e2e/remote-toggle |
| 10.02 | 레일 도구 → 원격 | 원격 목적지(레일 구성 D①-2) | 이동 | ② | e2e/workbench-shell |
| 10.03 | 페어링 카드("원격을 켜세요" 안내만) → QR 대화상자 | 같은 화면 스위치로 바로 켜기 | 대체 | B4 | vis/storybook; u:RemotePanel, PairingQrDialog |
| 10.04–10.05 | Android 연결 화면·연결 끊기 | 유지, 프로토콜 불일치 시 "업데이트 필요" | 유지 | B1·B4 | me2e/handoff-surfaces, qr-scanner, conversation-journey, planning-workflow, theme-effects-font, lib |

## 11. 이름 겹침

| id | 현재 라벨 ko / en | 위치 | 목표(D①-3 후보) | 묶음 |
|---|---|---|---|---|
| 11.01 | 워크스페이스 / Workspace | 헤더 분할·프리셋 메뉴 `R/workbench/AppHeader.tsx:147` | 배치 / 화면 배치 | ② |
| 11.02 | 작업영역 / Workspace | 워크스페이스 바 툴팁 `R/workbench/WorkspaceBar.tsx:37` | 배치 | ② |
| 11.03–11.06 | 작업 공간 / Workspace(s) | 작업 공간 탭 바, 레이아웃 토스트, Command Center 검색 문구, 최근 패널 | 스페이스 / 작업 세트 | ② |
| 11.07, 11.11–11.12 | 작업 공간 | 터미널 경로 토스트, 탐색기 삭제 문구, Project Map 문구 | 작업 폴더 / 실행 폴더 | ②·B2·B5 |
| 11.08 | 작업 공간 | 예약 실행 설정 | 작업 폴더 / 실행 폴더 | B5 |
| 11.09–11.10 | 에이전트 작업공간, 작업공간 식별자 | 옛 launch picker, 협업 설명 | 삭제·작업 폴더 | B5 |
| 11.13–11.17 | 작업 위치 / Work location · Working folder · Conversation workspace · Workspace | Project Explorer, 입력창 폴더 pill, 초안 옛 선택, 위임, 트리 | 작업 폴더 / 실행 폴더(ko·en 각각 1개) | B1·B2 |
| 11.18 | 작업 폴더 / Workspace | 옛 세션 시작 선택 | 삭제 | B1 |
| 11.19–11.20 | **Workspace, Worktree/Local(번역 안 됨)** | 옛 초안 폼, 대화 헤더 fallback | 번역·삭제 | B1 |
| 11.21–11.22 | 작업 폴더(git), 작업 폴더/작업 위치/작업공간 혼용 | 결과 탭, 변경 검토, 기록, 단계 설정, 워크트리 대화상자, 권한 문구 | 사전 단어로 통일 | B1–B3 |
| 11.23 | 워크스페이스 | Android 비평면 내비게이터(휴면) | 삭제 | B5 |
| 11.24 | 대화(탭) vs **프로젝트**(대화 페이지 제목) | Android `M/MobileTabBar.tsx:92` vs `M/MobileAgentView.tsx:1578` | 탭 이름 = 페이지 제목 | ② |

## 12. Command Center와 전역 단축키

| id | 현재 | 목표 | 묶음 | 거치는 테스트 |
|---|---|---|---|---|
| 12.01–12.03 | 헤더 검색 칸, Ctrl/Cmd+K(터미널·입력칸에서는 가로채지 않음), Ctrl/Cmd+Shift+P(전역 명령 모드) | 유지, 입력 맥락 정책 그대로(D①-6) | ② | e2e/workbench-shell, background-session, palette; u:QuickOpenModal, command-center-shortcut |
| 12.04–12.05 | Ctrl+Tab 최근 패널, Alt+Shift+=/- 분할 | 유지 | — | e2e/recent-panel-switcher, splits |
| 12.06 | 창 항목: **터미널 패널만**(대화 탭은 안 나옴) | 대화 탭 포함 | B1 | 없음 |
| 12.07–12.09, 12.11, 12.13 | 백그라운드 세션, 파일, 기록·빠른 명령, 프리셋, 관리 | 유지(파일은 파일 탭으로, B2) | B2 | e2e/background-session, popout-interaction-parity |
| 12.10 | 동작: 새 탭·분할·테마·프리셋 저장·목적지 열기·언어. **"프로젝트" 동작이 마지막 보기가 받은 요청이면 받은 요청을 엶**(`R/App.tsx:2643`) | 목적지 동작은 해당 목적지로 정확히 이동. "프로젝트"는 모든 프로젝트 대화상자(P-1, 2026-10-26) | ② | e2e/palette, workbench-shell; u:command-center-actions |
| 12.12 | 에이전트(1.19) | 1.19 | B1 | 없음 |
| 신규 | — | 프로젝트·소프로젝트·대화(기록 포함) 색인, 새 대화 명령 | B1 | — |

## 13. 데스크톱 셸 컨트롤

| id | 현재 | 목표 | 묶음 | 거치는 테스트 |
|---|---|---|---|---|
| 13.01 | 워드마크 + 버전 칩 | 타이틀바 워드마크(버전은 상태줄·정보) | ② | vis/storybook |
| 13.02 | 헤더 **새 터미널**(주 버튼) | 새 대화 ▾의 새 터미널 + Ctrl+Shift+` 후보 | ② | 12개 e2e(`btn-new-tab`) — §15 |
| 13.03–13.04 | 로봇 아이콘(1.01), 검색 칸(12.01) | 타이틀바 새 대화, 검색 | ② | — |
| 13.05 | 헤더 워크스페이스 메뉴(분할·프리셋) | 탭 줄 오른쪽 [배치] | ② | e2e/workbench-shell, layout-persistence, splits, drag-layout, popout-window; pkg/terminal-copy-packaged; u:WorkspaceMenu |
| 13.06 | FX·NEON 버튼 | 상태줄 효과 popover | ② | vis/storybook; u:EffectProfileMenu |
| 13.07 | 에이전트 알림(9.01) | 삭제 | ② | — |
| 13.08 | 창 제어(aria 영어 고정) | 유지, aria 번역 | ② | e2e/popout-window; vis/session-navigation |
| 13.09–13.16 | 레일: 프로젝트 · 받은 요청 · 도구 메뉴(모니터·원격·탐색기·OpenClaw) · 설정 | 레일 구성 D①-2(A안 평면 / B안 대화 첫 칸). 프로젝트는 위 막대 `+`(`shell-add-project`)·`모든 프로젝트`(`shell-all-projects`) 대화상자(P-1) | ② | `e2e/project-navigation.ts` helper(14개 e2e + pkg 2개), rail-tools 3개 + `e2e/workbench-navigation.ts` helper 6개, btn-toggle-settings 8개 — §15 |
| 13.17–13.18 | 사이드바 셸(1200px 미만 오버레이, 프로젝트는 1024px 미만), 목적지 6종 | 사이드바 하나에 목적지 하나(유지), 목적지 구성 D①-2 | ② | e2e/workbench-shell, status-panel, agent-experience; vis/storybook, workbench-tools; u:SidebarShell |
| 13.19 | 작업 공간 탭 바 | 탭 줄 오른쪽 [작업 세트] | ② | e2e/conversation-workbench-r7 |
| 13.20 | 워크스페이스 바 레이아웃 칩(위아래·2×1·1+2·단일) | [배치] 메뉴로 흡수 | ② | 없음 |
| 13.21 | 상태 표시줄(로컬/PC·미러링·RTT·대기 수·**언어 전환**·FX) | 원격·PC 제어·RTT·효과·언어·버전 | ② | 없음 |

## 14. Android 셸

| id | 현재 | 목표 | 묶음 | 거치는 테스트 |
|---|---|---|---|---|
| 14.01–14.06 | 하단 탭: 프로젝트 · 대화 · 작업 · 터미널 · 더보기 | Android 탭 구성 D①-2(A안 받은 요청·대화·프로젝트·터미널·더보기 / B안 확인할 일·대화·프로젝트·도구) | ② | me2e/lib(공통 helper), apk-stabilization, planning-workflow, subagent-tree, conversation-journey; u:MobileWorkspace, MobileTabBar |
| 14.07 | 600dp 이상 레일의 설정 | 유지 | ② | u:MobileTabBar, MobileWorkspace |
| 14.08–14.14 | 더보기: PC · 세션 · 파일 · 모니터 · OpenClaw · 테마 · 설정 | 탭 구성에 따라 재배치 | ② | me2e/apk-stabilization, parity, session-heavy-output-resume, theme-effects-font |
| 14.15–14.21 | 페이지 헤더(프로젝트·작업·**대화 페이지 제목 "프로젝트"**·세션·파일·새 세션·OpenClaw·설정·모니터·터미널) | 공통 페이지 헤더 1줄, 제목 = 탭 이름 | ② | me2e/conversation-journey, apk-stabilization, theme-effects-font, parity; u:MobileWorkspace, MobileAgentView, MobileFileView |
| 14.22–14.25 | 채팅: 내비게이션 줄 "CHAT", 초안 상태 문장, 대화 헤더(이전 대화·스킨·분리·종료와 보관·현재 작업 중단), Skills·plugins·MCP 줄, 변경 검토 버튼 | **채팅 헤더 1줄**(← · 제목+상태 · ⋯), 나머지는 ⋯ 시트와 입력창 칩으로 | ②(골격)·B1 | u:StructuredAgentSession, MobileAgentView, MobileStructuredAgentSession, MobileConversationReviewProvider, AgentCapabilitiesPanel |
| 14.26 | 마운트 안 되는 화면(`MobileHomeView`, `MobileAgentProjects`, 모바일 초안) | 삭제 | B5 | me2e/apk-stabilization, parity(오래된 대기) |

Android에는 `/new`가 없고 `/clear`는 사유와 함께 비활성, 위임도 없다. 목표에서는 데스크톱과 같은 경로를 쓴다.

## 15. 테스트 결합: 관문별로 다시 쓸 대상

셸 구조(헤더·레일·사이드바·탭 바)에 묶인 테스트다. 새 셸이 들어가는 관문 ②에서 **진입 부분을 새 셸 기준으로
다시 쓰고**(selector 땜질 금지, 기존 동작 단언은 보존), 각 묶음에서 여정 시나리오를 새로 쓴다.

**데스크톱 e2e(②)**

- 헤더: `e2e/workbench-shell`(헤더 구역 **4개** 단언, `btn-new-tab`, `btn-command-center`, `btn-workspace-menu`,
  `btn-toggle-agents`, `preset-menu`, `btn-split-*`, `.activity-rail`, `workbench-sidebar`, `.workbench-sidebar-scrim`,
  `sidebar-resizer`, `.dock-host[inert]`). `btn-new-tab`을 쓰는 12개: layout-persistence, lifecycle-soak, palette,
  popout-interaction-parity, popout-window, recent-panel-switcher, renderer-recovery, structured-agent-draft,
  tab-overflow, tabs, theme-effects-font, workbench-shell. 분할·프리셋: drag-layout, layout-persistence, popout-window,
  splits.
- 프로젝트(2026-10-26 P-1부터): `rail-agents`는 위 막대에서 사라졌다. helper `e2e/project-navigation.ts`
  (`openAllProjects`, `openProjectBoard`, `openProjectItems` = 판 `새 흐름`, `startNewConversation` = 작업 목록
  `btn-new-session`, `manageProject` = 모든 프로젝트 ⋯)를 14개가 쓴다(agent-activity-lifecycle, agent-experience,
  agent-history, agent-results, conversation-folders, planning-workflow, power-save, project-map-agent-session,
  project-workbench, run-folder-cleanup, structured-agent-draft, subproject-workflow, workflow-canvas-run,
  workflow-conversation). 대화상자 자체는 `e2e/project-dialogs`. `rail-tools`와 helper
  `e2e/workbench-navigation.ts`(file-explorer, openclaw-chat, openclaw-panel, project-workbench, status-panel,
  workbench-shell, openclaw-visibility). `btn-toggle-settings` 8개(interference-effects, openclaw-visibility,
  remote-toggle, settings, structured-agent-draft, theme-effects-font, theme, workbench-shell).
- 사이드바 내부: 데스크톱은 받은 요청과 프로젝트 파일(`project-workspace-*`)만 남았다. 예전 `agent-new-run`,
  `agent-project-open-*`, `project-conversation-tree`, `agent-project-history` 대신 `btn-new-session`,
  `all-projects-open-*`, `conversation-history-dialog`(출처 CLI 기록), 판의 `shell-board-new-flow`·`shell-board-new-terminal`.
  트리의 `session-end`를 쓰던 2개(agent-activity-lifecycle, structured-agent-draft)는 같은 guarded 종료를 API로 부른다.
- 작업 공간 탭: `e2e/conversation-workbench-r7`.
- 받은 요청을 여는 e2e는 **없다**(B1에서 추가).
- 패키지 e2e: `pkg/conversation-restart`, `pkg/project-history-navigation`, `pkg/terminal-copy-packaged`.

**Android e2e(②)**: 공통 helper `mobile/e2e/lib.ts`(`shell-tab-more`, `shell-tab-terminal`, `menu-btn`, `tab-add-btn`,
`workspace-hub-btn`, `more-*`)를 통해 모든 시나리오(apk-stabilization, parity, release-soak, session-heavy-output-resume,
theme-effects-font, handoff-surfaces, session-force-stop-recovery, smoke)가 결합된다. conversation-journey,
planning-workflow, subagent-tree는 탭 id에 직접 결합된다. apk-stabilization·parity는 **마운트되지 않는
`mobile-home-view`를 아직 기다린다**.

**Visual(②)**: `vis/session-navigation`, `vis/workbench-tools`, `vis/storybook`(헤더 버튼 id, 사이드바, Android
`workspace-hub-btn`, `.mobile-page-header`, `.mob-agent-filters`). 채팅 세션·실제 터미널 snapshot은 아직 없다(②에서 추가).

**단위 테스트**: `u:WorkspaceMenu`, `u:SidebarShell`, `u:ActivityRail.update`, `u:MobileTabBar`, `u:MobileWorkspace`.
StatusBar·WorkbenchViewsBar·WorkspaceBar·MobileMoreSheet는 단위 테스트가 없다.

**도구·가드**: `scripts/profile-runtime.mjs`(rail·sidebar selector), `scripts/verify-ux-live.mjs`,
`scripts/capture-ux-overhaul.mjs`, `scripts/design-reference-guard-core.mjs`의 legacy Electron 검사
(`btn-command-center`, `btn-new-tab`, `btn-toggle-files`).

## 16. 교차 검증과 조사 중 발견한 결함

두 인벤토리는 분류·진입점·테스트 결합에서 일치했다. 차이와 확인 결과:

- Project Map 만들기(1.23): Codex는 "전용 Agent 세션"으로 적었으나, 실제로는 `launchAgent`가
  `openTerminal({ agentBootstrap })`로 **터미널 탭에서 CLI 에이전트**를 연다(`R/App.tsx:2026`). 대화가 아니다.
- Codex가 더 찾은 것: 옛 프로젝트 카드·launch picker(1.31), Android 터미널 새 세션 3곳(1.30), 미사용 Android
  화면(1.32), 셸 helper를 통해 결합된 Android 시나리오 3개(handoff-surfaces, session-force-stop-recovery, smoke).
- Claude가 더 찾은 것: 데스크톱 기록 대화상자의 "CLI에서 이어가기"가 도달 불가(3.06), 받은 요청 수 공식 3종(9.x).

개편 묶음에서 함께 고칠 결함(새 기능 아님, 흐름 정돈의 일부):

| 결함 | 근거 | 묶음 |
|---|---|---|
| Command Center "프로젝트" 동작이 마지막 보기가 받은 요청이면 받은 요청을 엶 | `R/App.tsx:2643` | ② |
| 받은 요청 수가 헤더·레일/상태줄·Android에서 서로 다름 | `R/App.tsx:1535,3088`, `M/MobileWorkspace.tsx:907` | B1 |
| 테스트 id `agent-project-new-chat-*`가 터미널을 엶 | `R/AgentHub.tsx:1545` | B5 |
| ko 화면에 영어 라벨(Provider/Workspace/Model, Worktree/Local) | `R/StructuredAgentSession.tsx:389-394,2341` | B1 |
| 데스크톱 기록 대화상자의 "CLI에서 이어가기" 도달 불가 | `R/App.tsx:3322-3333` | B1 |
| Android 대화 탭 이름 "대화"와 페이지 제목 "프로젝트" 불일치 | `M/MobileTabBar.tsx:92`, `M/MobileAgentView.tsx:1578` | ② |
| 창 제어 aria가 영어 고정 | `R/workbench/WindowControls.tsx:52-80` | ② |
| 휴면·미사용 코드(ActivityRail 비프로젝트 분기, Android 비평면 내비게이터, 미마운트 화면, 안전 모드 외 launch picker) | §1.29–1.32, §2.02 | B5 |
