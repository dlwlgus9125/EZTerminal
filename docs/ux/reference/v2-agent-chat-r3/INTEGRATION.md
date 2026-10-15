# r3와 기존 제품의 연결

[r2의 소스 대응](../v2-agent-chat-r2/INTEGRATION.md)을 유지하고,
[수정 계획](../../agent-workflow-plan.md)의 기획 식별·초안 격리·세션 연결을 화면으로 검토합니다.

| 기존 제품 경계 | r3에서 검토하는 보완 |
| --- | --- |
| PlanningWorkspacePanel / MobilePlanningNavigator | 기획 목록, 생성, 범위 전환, 이름 변경·보관·복원 |
| 기존 프로젝트 기획 저장·암호화 초안 | 기획별 내용·미저장 편집을 격리. 시안에서는 메모리 객체만 사용 |
| StructuredAgentSession과 기존 세션 저장소 | 관련 기획 표시와 일반 대화 연결. 같은 세션·입력 보존 |
| PlanningQuickTaskCard / PlanningExecutionPanel | 기획 없는 빠른 작업과 기존 준비·시작·담당 세션 재사용 |
| PlanningResultDetails | 정확한 결과에서 수정 요청을 정리하고 관련 문서로 복귀 |

`plans.js`는 검토용 목록/연결을, `journey.js`는 기획별 단계 상태를,
`prototype.js`는 공통 대화·확장 UI를 담당합니다. 이 파일들을 제품으로 복사하지 않습니다.

실제 구현은 기획별 revision, 기존 immutable baseline과 receipt 보존, project/plan/session 검증,
구버전 host/client 호환, 원격 권한과 backup 확장이 먼저 필요합니다. r3의 임시 ID나 메모리 저장을
제품 저장 schema의 확정안으로 간주하지 않습니다. 과거 결과와 새 시도의 완전한 원장 역시 제품에서 검증합니다.
