# 이전 구현과 r2의 연결

현재 제품에서 관찰한 구현과 r2가 제안하는 보완을 구분합니다. 이 문서는 새 제품 구현 완료 기록이 아닙니다.

## 이미 존재하는 연결

| 소스 | 확인한 현재 동작 | r2에서 유지하는 책임 |
| --- | --- | --- |
| [PlanningWorkspacePanel](../../../../src/renderer/PlanningWorkspacePanel.tsx) | 프로젝트의 기획·디자인·대화·작업·검토, 문서 편집, AI 제안 명시 적용, 기준선 확정 | 문서와 구조화된 제안·확정본의 권위 |
| [PlanningWorkspaceDockPanel](../../../../src/renderer/PlanningWorkspaceDockPanel.tsx) | `onOpenConversation(id)`를 navigation에 전달하고 프로젝트의 실제 대화를 조회 | 같은 세션을 여는 기존 경로 |
| [App](../../../../src/renderer/App.tsx) | `planningNavigation.openConversation` → `openStructuredAgentSession` | 공통 대화 surface를 열고 기존 세션 재사용 |
| [PlanningExecutionPanel](../../../../src/renderer/PlanningExecutionPanel.tsx) | `attempt.sessionId`로 담당 AI 대화를 열고 해당 세션의 승인·질문 대기 표시 | 실행/attempt와 실제 요청의 연결 |
| [PlanningResultDetails](../../../../src/renderer/PlanningResultDetails.tsx) | 정확한 결과·검증·독립 검토와 `reviewerSessionId` 대화 연결 | 검토 대상과 검토자 분리, 결과 권위 |
| [MobilePlanningNavigator](../../../../mobile/src/MobilePlanningNavigator.tsx) | 같은 PlanningWorkspacePanel을 쓰고 `onOpenConversation`을 `onOpenChat`으로 전달 | Android가 같은 프로젝트·실제 세션을 여는 경로 |
| [MobileWorkspace](../../../../mobile/src/MobileWorkspace.tsx) | `activeAgentSessionId` 설정 후 대화 탭으로 이동 | 모바일 공통 대화와 탐색 연결 |
| [planning-ai-service](../../../../src/main/planning-ai-service.ts) | 참조·프로필 snapshot, 도구 격리, 구조화된 제안 검증, expected revision 대조 후 명시 적용 | 논의·제안·문서 쓰기·실행의 경계 |

작업 담당과 검토 대화로 진입하는 기반은 이미 있습니다. 기존 callback이 주로 세션 ID를 전달하므로 **출발 화면·참조 대상·복귀 위치를 대화 UI에서 충분히 드러내는 보완**이 필요합니다. r1은 일반 대화 자체를 개선한 시안이어서 이 왕복을 체험하지 못했습니다.

## 제품 반영 때 추가할 연결 정보

필드 이름은 설계 제안이며 실제 schema는 기존 타입을 확인한 뒤 확정합니다.

- **대화 연결:** project/workspace/session, 역할·목적, 관련 문서·화면·작업의 stable ID. 같은 주제의 대화를 재사용할 수 있도록 하고 단계 이름만으로 새 세션 생성을 강제하지 않습니다.
- **참조 snapshot:** 문서·scene의 revision, baseline fingerprint, attempt ID, result artifact revision/commit. 화면에서 읽는 참조와 AI 요청에 포함한 참조가 같아야 합니다.
- **복귀 위치:** 원래 영역·선택 항목·읽던 위치. 탐색 정보는 표시 상태이고 문서 revision이나 실행 권한을 소유하지 않습니다.
- **변경안:** 원본 대상·revision과 검증된 제안·명시 적용 명령. 자유 텍스트 답변을 곧바로 원본 쓰기로 취급하지 않습니다.
- **제공자 capability:** 일반 논의에서 가능한 기능과 구조화된 제안 생성·관리형 실행에서 허용하는 기능을 구분합니다. UI의 공통 모양이 권한 동일성을 뜻하지 않습니다.

기존 코드의 세션·기획 저장소·실행 원장을 그대로 권위로 사용합니다. 새 일반 대화 저장소나 병렬 실행 관리자를 중복 생성하지 않습니다. 제품에 적용할 때 `onOpenConversation(sessionId)`의 호출부에 선택적 진입 맥락을 더하고, 공통 대화 헤더/참조 영역과 돌아가기 경로를 연결하는 방식이 출발점입니다.

## 이전 단계의 결정을 다음 단계로 전달

요구사항에서 디자인으로 넘어갈 때 전달하는 기본값은 저장·반영한 문서와 명시된 참조입니다. 전체 대화 기록을 자동 복제하지 않습니다. 필요하면 결정 요약을 검토 가능한 참조로 연결할 수 있습니다. 예시 r2는 요구사항의 새 버전을 디자인 대화에, 확정한 요구사항·디자인을 작업·검토 대화에 표시합니다.

독립 검토는 구현 대화에 합쳐지지 않습니다. 동일 결과 revision과 검증 근거로 연결해 사용자가 반복 설명하지 않도록 하되, 검토자의 판단 경계를 보존합니다. 원본이 갱신되었어도 실행 중 snapshot을 자동으로 교체하지 않습니다.

## 구현 후 필요한 검증

1. 실제 문서/scene → 대화 → 원래 항목으로 복귀할 때 stable ID, 초안, 선택, 스크롤이 보존되는지 확인합니다.
2. 문서 버전 변경과 미저장 편집을 실제 host command에서 대조하고 원본 덮어쓰기를 막는지 확인합니다.
3. 문서 적용·실행 준비·대화 열기가 추가 모델 턴이나 실행 시작을 일으키지 않는지 실제 daemon에서 검증합니다.
4. 담당 attempt와 독립 reviewer의 세션을 재사용하고, 대화에서 관리형 실행의 frozen 설정을 우회 변경할 수 없는지 확인합니다.
5. 결과 revision·commit·검증·독립 검토가 같은 결과를 가리키는지 기존 통합 gate에서 확인합니다.
6. Android 전환·오프라인·Back·프로세스 재시작·실제 IME와 Windows 좁은 창·배율·보조 기술을 검증합니다.

r2의 브라우저 테스트는 위 요구사항의 화면·시뮬레이션 증거입니다. 기존 [구현·검증 기록](../../../ezterminal-v2-implementation.md)의 제품 검사 결과를 새 구현의 결과로 재사용하지 않습니다.
