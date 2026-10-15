# EZTerminal 2.0 설계 구조

r6 사용자 승인 기준이다. [승인 기록](APPROVAL.md)과 별도로 제품 구현·검증 근거를 남긴다. 기존 Electron main의 단일 writer, revision·idempotency·outbox·safe mode를 확장한다. 새 웹 서비스나 별도 모바일 실행 권위는 만들지 않는다.

## 데이터 소유권

| 모델 | 내용 | 저장 |
| --- | --- | --- |
| PlanningItem | 요구사항·기능·정보 구조·흐름 | 프로젝트 기획 원본 |
| PlanningLink | 관계·참조 버전·검토 영향 | 프로젝트 기획 원본 |
| ScreenScene | 요소·배치·상태·이동·컴포넌트 참조 | 프로젝트 기획 원본 |
| PlanningBaseline | 검토한 항목과 hash의 변경 불가능한 snapshot | 프로젝트 기획 원본 |
| TaskDefinition | 목적·범위·선행 작업·완료·검증 조건 | 프로젝트 기획 원본 |
| AgentProfile / TeamPreset | 역할 지시·문맥 규칙·권한 한도·운영 방식의 버전 | 공유 가능한 템플릿은 프로젝트 기획 원본; 모델 binding·인증 참조는 PC 설정 |
| ExecutionRun | 기준 설계·실제 배정·진행·검증 상태 | runtime DB |
| ExecutionAttempt | 작업의 한 실행 시도, 요청/적용 모델·옵션, 지시·참조 snapshot, 완료 근거 | runtime DB. 비밀값을 포함하지 않으며 접근 권한·보존 정책 적용 |
| TaskMessage / DecisionGate | 작업·시도별 질문·답변·진행·완료와 대기 해소 기록 | runtime DB |
| ContextReference | 항목·파일·요소·버전 참조 | 기획 또는 해당 대화 소유 |
| ReviewEvidence | 대상 revision·검증·캡처·결정 | 기준 설계 및 실행에 연결 |

기획 원본은 `.ezterminal/planning/`에 보관한다. 실행·대화는 기존 `orchestration.sqlite3`에 둔다. 레이아웃·보기·테마는 기기별 preference다. runtime 상태를 Git 추적 기획 파일에 반복 복제하지 않는다. 독립 Roadmap 모델은 없다.

## 편집과 버전

기획 수정은 항목 ID·expectedRevision·변경 묶음 ID를 받아 원자적으로 저장한다. AI와 직접 편집은 같은 command를 사용한다. 외부 파일 변경은 재색인하되 진행 중 편집과 충돌하면 병합 확인을 요구한다. 각 변경 묶음을 되돌릴 수 있으며 이전 버전 참조는 유지한다.

상위 요구사항 변경은 연결된 기능·화면·작업을 검토 필요로 표시한다. 초안에서는 사용자가 요청한 범위의 AI 수정이 즉시 반영된다. 확정본은 덮어쓰지 않는다. 새 초안의 완료가 기존 실행의 baseline을 바꾸지 않는다. 새 기준 적용은 영향 작업을 확인한 재계획 명령으로 수행한다.

## 공통 인터페이스

- planning.read / planning.patch: 항목·참조 버전 조회와 변경.
- planning.freeze / planning.branch: 검토 조건 검사, 확정본 생성·새 초안.
- run.prepare / run.start: 기준 설계·작업 그래프·담당·검증 조건.
- run.pause / run.resume / run.cancel: 새 배정 중지·재개·실행 취소.
- review.resolve: 정확한 설계·코드 revision과 결정을 결속.
- project.file.write: 파일 content revision 확인 후 저장, 충돌 결과 반환.
- context.capture: 화면·요소 ID, DOM·스타일·캡처, 확인 가능한 소스 위치.
- integration.link / integration.refresh: 외부 항목 ID와 연결 상태.

같은 typed command envelope를 IPC·Android WS·CLI·MCP가 사용한다. schema와 protocol은 구현 시작 시 실제 최신 버전에서 증가시키며 구버전 client의 지원하지 않는 동작은 명시적으로 거절한다. 기존 terminal 호환 경로는 유지한다.

## 기획 권한과 실행 권한

앱의 '기획 단계'는 provider의 permission preset과 별도 제품 정책이다. 기획 도구는 명시적으로 허용된 planning namespace에만 쓸 수 있고 제품 소스 수정·셸 실행 도구는 실행 단계로 전환하기 전 허용하지 않는다. 확정과 실행 시작은 서로 다른 command다.

빠른 작업은 전체 기획 문서 대신 목적·대상·완료 조건을 가진 짧은 TaskDefinition을 만든다. 사용자가 그 실행을 시작하면 기존 permission·approval 계약 아래 수행한다.

## AI 팀과 작업 공간

단계별 프로필·모델 선택·프롬프트 조립·단일/분업/후보 비교/독립 검토의 상세 계약은 [AI 운영 설계](AI-OPERATING-MODEL.md)가 소유한다. 호스트 정책과 제공자 capability가 프롬프트보다 우선한다. 프로필 조회·화면 이동은 실행 명령이 아니다.

대표 AI는 작업 분해·조정·요약을 제안하고 호스트가 DAG·선행조건·동시성·상태 전이·완료 근거를 관리한다. 변경 작업은 dedicated worktree를 사용한다. 공유 파일·계약의 동시 수정 범위가 겹치면 순서를 조정한다. 기존 managed cap 4 turns / 16 nodes / depth 4를 기본 경계로 유지한다.

일시정지는 새 작업 배정을 멈추며 진행 중 turn은 종료까지 상태를 표시한다. 중단은 queued·running 작업에 취소를 전달하고 확인된 결과만 기록한다. provider-native child는 해당 provider가 소유하며 read-only 제약을 유지한다. 사용자는 managed child와 직접 대화할 수 있다.

자율 실행은 합의한 범위 안에서 수행하며 기본 종점은 로컬 통합 브랜치와 검증이다. main merge·push·외부 발행·배포는 별도 명시적 사용자 행동이다. 검증 실패와 stale target은 자동 통합하지 않는다.

## 화면 편집·실행 미리보기

ScreenScene은 frame·text·input·button·list·table·tabs·dialog와 layout·상태·이동을 구조화한다. 앱 chrome에서 임의 HTML/스크립트를 실행하는 모델을 쓰지 않는다. 외부 실행 화면은 격리된 browser surface로 다루고 요소·캡처·소스 위치를 참조로 전달한다. source map이 없으면 위치 미확인을 유지한다.

기존 파일 편집은 read-only였으므로 write와 revision 충돌은 신규 구현이다. protocol의 browser kind만으로 완성된 browser 기능이 존재한다고 간주하지 않는다. 현재 structured provider 등록은 Codex·Claude 중심이며 다른 adapter는 실제 capability 검증 후 활성화한다.

## Android와 복구

Android는 같은 권위의 snapshot·revision과 command receipt를 관찰한다. 재연결 후 미확정 명령을 먼저 대조한다. plaintext layout에 prompt·credential을 저장하지 않는다. 기존 secure recovery와 auth authority 결속을 보존한다. 화면 전환은 terminal controller를 재생성하지 않는다.

현재 PC 제어의 명시적 Start, 입력 release, Bluetooth·IME, local clipboard 동작을 유지한다. provider 설치·browser hosting·검증 실패 override 같은 Desktop-only 기능은 모바일에서 가짜 control을 만들지 않는다.

## 이전과 검증

기존 설정·세션·provider 기록·작업 공간을 비파괴적으로 이전한다. 프로젝트 기획 폴더가 없어도 이전 terminal·대화를 사용할 수 있다. migration은 backup·복구·실패 시 safe mode를 포함한다. 현재 미커밋 사용자 변경은 제품 구현 시작 시 보존하고 기준 revision을 다시 확인한다.

## 기획 이후 인계의 상세 계약

TaskDefinition·ExecutionAttempt·Evidence·ReviewDecision·IntegrationResult와 출시 준비의 필수 필드·상태 전이·실패 복귀는 [기획 이후 설계](DELIVERY-DESIGN.md)가 소유한다. 기존 공통 인터페이스에 이 계약을 연결하며 UI만으로 검증·완료 상태를 결정하지 않는다.


## 확정 정책의 상태·저장 계약

2026-10-13 확정한 [11개 운영 정책](POLICIES.md)을 반영한다. 상세 상태·Task/Session/Turn 연결·변경 계획·재시도·프로필·환경 격리·백업·Android 초안·Scene 공통 요소는 [POLICY-CONTRACTS.md](POLICY-CONTRACTS.md)를 따른다. [정책별 화면](index.html#policies)에서 정상·대기·복구를 단계별로 검토한다. r6 전체 설계 승인 이후 실제 제품 구현·검증은 별도 근거로 확인한다.
