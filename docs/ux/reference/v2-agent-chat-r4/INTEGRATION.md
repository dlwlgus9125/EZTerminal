# r4와 기존 구현의 연결

이번 변경은 [계획](../../agent-workflow-plan.md)과 검토용 HTML에 한정됩니다. 다음은 제품 구현 시
확장할 경계이며 이미 구현된 그래프 API나 앱 스킬이 아닙니다.

| 기존 경계 | 적용할 변경 |
| --- | --- |
| PlanningWorkspacePanel / MobilePlanningNavigator | 프로젝트의 동등한 소프로젝트·일반 대화 목록, 프리셋/대화 생성과 단계 진입 |
| planning.ts / planning-service / draft store | 기존 기획 단위를 소프로젝트로 확장. 그래프·stable node/edge IDs·revision·이전·복구 |
| StructuredAgentSession / 기존 세션 저장소 | 같은 채팅 UI·메시지·입력 보존, 단계별 여러 대화와 flow-edit scope |
| planning-execution / preparation / run authority | 고정 stage enum과 사용자 노드 이름 분리, 그래프 검증·snapshot·기존 task/attempt 매핑 |
| PlanningExecutionPanel / ResultDetails | 그래프 실행 상태에서 정확한 실행·검토 세션/결과로 이동. 기존 승인/통합 gate 유지 |
| AgentControlServer / orchestration MCP | 실제 host 권한·project/subproject scope·revision·idempotency를 검증하는 공유 명령 경계 |
| provider adapter / 확장 discovery | 첫 메시지 전 앱 스킬 가용성, 실제 도구 연결과 설치된 스킬 목록 구별 |
| ProjectMap | 다이어그램 reader/authoring 경험만 참고. map JSON을 실행 명령으로 해석하지 않음 |

기존 baseline bytes/hash·receipt·attempt·result ID는 이전 과정에서 다시 쓰지 않습니다. 별도 소속 매핑을
사용하고, 일반 대화를 제목으로 자동 분류하지 않습니다. 원격 protocol·암호화 초안·프로젝트 백업도 같은 경계를
포함해야 합니다. 구버전 client의 누락된 소프로젝트 ID를 현재 화면 선택으로 채우지 않습니다.

## AI 스킬 후보

가칭 `ezterminal-workflow`는 앱 안에서 흐름 조회·생성·편집·검증·변경 내역·되돌리기와 실행 조회를
돕는 절차입니다. 실제 상태 변경은 UI와 같은 host command로 수행합니다. AI 초안 편집은 직접 반영하고
실행 시작·노드 승인·파일 권한은 각각의 명시 경계를 유지합니다. 실행 snapshot과 결과는 쓰기 대상이 아닙니다.

현재 스킬 카드와 예시 응답은 시안 데이터입니다. 실제 SKILL.md 설치·MCP/CLI 도구·외부 앱 인증을 추가하지
않았습니다. 외부 Codex/Claude 앱에서도 사용할지의 범위는 확정되지 않았습니다. 앱 내부 경로를 먼저 설계하며
기존 native 설정 공유 요구와 충돌하지 않도록 구현 시 provider별 노출·호출을 확인해야 합니다.

## 시안 구성

`workflow-model.js`는 검증과 제한된 실행 모형, `workflows.js`는 r4 탐색·편집·대화 연결을 소유합니다.
`prototype.js`의 공통 대화·확장 UI를 사용하고 `journey.js`/`plans.js`는 r1–r3 비교 장면을 유지합니다.
페이지 메모리만 사용하며 이를 production 저장 포맷 또는 실행 엔진으로 채택하지 않습니다.
