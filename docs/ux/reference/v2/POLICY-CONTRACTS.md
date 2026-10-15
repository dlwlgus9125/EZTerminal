# 확정 정책의 동작·데이터 설계

상태: r4에서 확정한 11개 운영 정책을 유지하는 계약. 2026-10-13의 후속 전체 지시로 r6 설계·P6/P7·G1–G8 구현 진행을 승인받았다. 개별 화면 클릭 검토나 구현 완료를 의미하지 않는다. [승인 근거](APPROVAL.md) · [정책과 예상 화면](index.html#policies) · [정책별 대응표](POLICIES.md).

정책 원문은 [policy-planning.mjs](policy-planning.mjs)의 I01–I11이 소유한다. 이 문서는 상태·명령·실패·복구 의미를 구체화한다. 기존 활성 DESIGN.md·UX 계약을 변경하거나 runtime 구현을 추가하지 않는다.

## 1. 작업·시도·대화의 연결

| 객체 | 역할과 관계 | 상태 소유자 |
| --- | --- | --- |
| TaskDefinition | 목적·범위·완료 조건과 의존 관계. 수정은 새 task revision | PC host, 기획 원본에 정의 |
| ExecutionRun | 시작한 작업 집합·운영 방식·진행 정책·종점. 기준 묶음은 불변 | PC runtime DB |
| ExecutionAttempt | task revision의 1회 배정. sessionId·turnId·workspaceId·dispatchId·기준·프로필 snapshot에 결속 | PC runtime DB |
| Session / Turn | 세션은 대화 연속성, turn은 실제 provider 실행. 여러 task의 상태를 세션 상태 하나로 대신하지 않음 | 기존 관리형 세션 host |
| DecisionGate | 사용자 질문·재시도 소진·모델 대체·변경 계획 확인 등 대기 이유와 해소 명령 | PC runtime DB |

Task에는 여러 attempt가 있을 수 있지만 단일 배정에서 중복 live attempt를 만들지 않는다. 후보 비교는 candidateId별 별도 attempt·workspace·session을 사용한다. 한 session의 실행 turn은 동시에 여러 attempt에 소유되지 않는다. 일반 대화 turn은 Task가 없을 수 있다. 검토 세션은 작성 세션과 분리한다. 기존 session archive·detach는 Task 완료·취소로 해석하지 않는다.

UI는 host snapshot과 command receipt를 보여 준다. Android·renderer·CLI가 각자 상태를 확정하지 않는다. commandId와 expectedRevision으로 중복·경합을 제어한다. 검토는 baseline+artifactRevision+evidence에 연결한다.

| 사용자 행동 | 의미 | 보존·복구 |
| --- | --- | --- |
| 일시정지 | 새 배정 중지. 진행 중 turn은 별도 상태로 관찰 | 이 상태만으로 실행 중 작업이 멈췄다고 표시하지 않음 |
| 현재 시도 중단 | 해당 turn의 cooperative cancellation 요청 | 확인 전 stopping, 단절 시 reconciling. 결과 추정 금지 |
| 작업 취소 | 해당 작업의 새 배정 차단 및 현재 시도 중단 요청 | 기록·산출물 보존. 의존 작업은 dependency-cancelled 대기 |
| 재시도 | 현재 조건을 확인한 새 attempt 생성 | 이전 실패·취소 결과와 늦은 메시지를 현재 결과와 구분 |

## 2. 요구사항 변경과 재개

초안 편집 자체는 실행 기준을 바꾸지 않는다. 실행 중 범위와 연결된 변경이 확인되면 host는 영향 작업+전이 의존 집합을 계산하고 해당 집합의 새 배정·검토 수락·통합을 보류한다. 실행 중 영향 작업에는 중단 가능한 지점의 정지를 요청한다. 종료 확인 전에는 **멈추는 중**이며 결과가 늦게 도착해도 변경된 기준의 완료로 받지 않는다. 무관한 작업은 계속한다.

ReplanProposal은 oldBaselineId, proposedBaselineId, expectedRunRevision, affectedTaskIds, downstreamTaskIds, unaffectedTaskIds, 재사용 가능한 결과, 재작업, 변경된 검증 기준을 포함한다. 의존 관계가 불명확하면 그 관계가 있는 후보 집합을 보류하고 근거를 표시한다.

변경 계획 확인 전/취소/검토 미완료 상태에서는 보류를 유지한다. 사용자가 기존 요구를 유지하기로 하면 원래 기준으로 명시적으로 재개한다. 적용 시 새 기준의 연결된 run segment와 task revision을 만들고 이전 Run·Attempt의 snapshot은 수정하지 않는다. 무관한 결과는 정확한 revision의 외부 의존 참조로 재사용한다. 확인 이후 기준·작업 graph가 바뀌면 계획을 stale로 처리해 다시 제시한다.

예시: T04 대화 스킨 변경 → T04와 통합 T06 보류 → 독립 T09 SSH 유지 → 영향과 재작업 확인 → 새 설계 v2 검토 → 변경 계획 적용 → 새 시도 배정. [U08](index.html#flows?journey=U08), [PF02](index.html#policies?flow=PF02).

## 3. 빠른 작업과 재시도

QuickTaskDraft에는 목표·대상 프로젝트/경로·허용 범위·완료 조건·검증 계획이 있다. 대화에서 카드를 수정하거나 취소할 수 있다. 실행 클릭은 범위·현재 revision·provider capability 확인 후 task와 첫 attempt를 생성한다. 미충족이면 카드를 유지하고 해당 항목만 수정하게 한다. 카드 생성, 스킨 전환, 화면 이동, 재연결은 실행이 아니다.

검증 재시도는 task revision과 원래 attempt에서 시작하는 RepairSeries로 묶는다. retryLimit 기본 2, retriesUsed, attemptIds, failureEvidenceIds, stoppedReason을 기록한다. **최초 실패 + 추가 수정·재검증 2회**가 기본이며 각 수정·재검증 묶음이 1회를 소비한다. 여러 검사 실패를 각각 2회로 곱하지 않는다. host에 기록해 재시작·검토 왕복으로 횟수를 초기화하지 않는다. 0이면 자동 재시도 없이 대기한다. 설정 변경은 새로운 작업부터 적용하며, 현재 작업의 추가 시도는 사용자의 명시적 결정으로 별도 기록한다.

소진 시 결과·수정 내역·검사 결과·남은 문제를 보여 주고 추가 수정 지시/추가 1회/취소를 제공한다. AI 연결 오류·권한 대기·사용자 취소·불명확한 실행은 검증 실패와 구분하며 자동 repair를 만들지 않는다. 전체 실행 시간 제한은 없지만 heartbeat 상실은 연결 확인·대조로 전환한다. 개별 도구의 자체 timeout은 전체 run 시간 제한과 별개이고, 같은 실패를 무한 반복하는 근거가 아니다.

## 4. 프로필 수정과 모델 장애

프로필은 기존 기본→프로젝트→작업 상속을 유지한다. 원문·현재 저장 버전·미저장 편집을 구별하고 모델, 제공자 지원 추론 옵션, 지시문, ContextReference, 허용 도구를 편집한다. 사용자는 변경을 저장하거나 버릴 수 있다. 되돌리기는 과거 버전을 지우지 않고 그 내용을 복원한 새 버전이다.

AI 수정은 ProfilePatchProposal(baseVersion, fieldDiffs, 이유, validationResult)을 만든다. 제안 생성은 실행 프로필을 수정하지 않는다. 변경 전후·영향 역할을 보여 주고 적용할 때 baseVersion·capability·상위 정책을 재확인한다. 기획 역할은 제품 코드 실행 권한을 받을 수 없다. 동시 편집으로 baseVersion이 달라지면 덮어쓰지 않고 재비교한다. 현재 attempt의 prompt·model·context·tools snapshot은 영구히 유지한다. 새 배정만 저장된 새 버전을 사용하며 재시도·대체 실행도 새 snapshot을 기록한다.

준비 검사는 선택한 방식의 참여 역할만 대상으로 한다. 단일은 선택 역할, 분업은 대표와 배정할 역할, 후보 비교는 후보들, 독립 검토는 검토 역할을 검사한다. 이후 단계 역할은 해당 단계 배정 전에 점검한다. 단일 작업이 미사용 Android 담당의 설정 때문에 막히지 않는다. 단일 작성 결과도 완료·통합에 필요한 독립 검토는 별도 단계에서 수행한다.

provider 연결/사용량 장애는 provider-unavailable 대기이며 자동 대체는 하지 않는다. 사용 가능한 대안·중단 원인·마지막 확인을 표시한다. 사용자가 복구한 기존 AI 또는 대체 AI를 선택하면 이전 명령 결과·파일 변경·권한을 먼저 대조한다. 인계는 목적·완료 조건·확정 참조·변경 diff·시도 요약·남은 문제·검증 근거로 구성하고 누락은 표시한다. provider의 비공개 reasoning 재생을 전제하지 않는다. 불명확한 명령은 그대로 재생하지 않는다.

## 5. 병렬 작업의 실행 환경

파일 worktree만 나누면 충분하지 않다. W01 계약과 W06 scheduler가 EnvironmentLease를 소유한다: runId/taskId/attemptId, worktree, process IDs+시작 identity, port assignments, preview origin, test DB/schema, 임시 데이터·build 출력 경로, 상태와 정리 결과.

- 서버·포트는 host가 충돌을 확인해 배정한다. 고정 포트만 가능한 도구는 직렬화하거나 설정 필요 상태로 표시한다.
- 테스트 DB·임시 출력은 attempt별 namespace를 사용한다. 의존성 cache는 도구가 안전하게 공유할 때만 공유하며 lockfile을 동시에 바꾸지 않는다.
- 환경 설정은 project base + attempt override로 조립하고 credential은 기존 보안 저장소 참조로 주입한다. 비밀값을 planning 파일·캡처·백업 manifest에 넣지 않는다.
- 미리보기는 task/candidate/revision/서버 상태를 표시한다. 선택한 후보와 다른 서버 결과를 비교 근거로 쓰지 않는다.
- 완료·취소 시 host가 소유한 서버/임시 lease를 정리한다. 열어 둔 미리보기는 명시적으로 유지하거나 닫을 수 있다. worktree·결과·로그는 자동 삭제하지 않는다.
- PC 재시작 시 포트·프로세스 identity를 재확인한다. PID만 같다는 이유로 타 프로세스를 종료하지 않는다. 잔여 lease를 orphaned로 표시하고 원본을 보존한다.

## 6. 백업·복원·보관

백업과 외부 공유는 목적이 다르다. **프로젝트 백업·이동 기본값은 전체 기록**이다. 외부 공유용 문서/화면 내보내기는 대상과 포함 항목을 별도로 확인한다. 인증 정보(API key, token, SSH private key, 기기 pairing)는 둘 다 제외한다. 로그에 이미 섞인 인증값은 마스킹하고 누락·제외 manifest를 제공한다. 기획·대화에 사용자가 직접 적은 민감 내용까지 완전 자동 탐지한다고 약속하지 않으며 내보내기 목록·미리보기에서 확인한다.

PackageManifest에는 schema/version, source project identity, source revision, 데이터 일관성 기준 시점, 항목 ID·hash·길이·종류, 자산·대화·attempt·evidence 참조, 제외 사유를 기록한다. SQLite는 실행 중 DB 파일을 단순 복사하지 않고 일관된 snapshot/export로 읽는다. 프로젝트 기획 snapshot과 연결 참조를 같은 export barrier에 결속한다. 작성 중 원본이 바뀌면 다시 일관성을 확보한다.

첨부·화면 이미지·폰트 등 프로젝트 보유 자산은 content hash로 포함한다. 외부 source repository·임의 절대 경로·실행 바이너리를 전체 기록이라는 이유로 재귀 수집하지 않는다. 프로젝트 소스는 별도 repository 연결로 확인하며, 미통합 작업물은 patch와 base revision·필요 blob으로 보존해 다른 PC에서 복구할 수 있게 한다. 재배포 제한 자산·외부 참조는 미포함과 복원 조건을 명시하며 완전한 이동 가능으로 표시하지 않는다.

복원은 staging 위치에서 경로 탈출·손상·schema·필수 참조를 확인한 뒤 새 프로젝트 또는 충돌 확인을 거친 복사본으로 저장한다. 설치되지 않은 AI·사라진 경로는 연결 필요로 남긴다. 과거 실행은 기록으로 복원하며 살아 있는 프로세스·인증·실행 승인을 이식하지 않는다. 중단 시 원본과 이전 백업은 유지한다.

기록은 기간·용량 기준으로 자동 삭제하지 않는다. 설정에서 프로젝트/종류별 용량과 삭제 대상을 보여 준다. 활성 실행·확정본 필수 참조·보류 후보를 포함하면 삭제를 차단하거나 먼저 명시적 보관·관계 해소를 요구한다. 되돌릴 수 없는 삭제는 대상과 결과를 확인한다. 용량 부족에서는 새 큰 쓰기/배정을 보류하고 원본을 보존한다. 다른 기록을 몰래 지우거나 저장되지 않은 결과를 완료로 표시하지 않는다.

## 7. Android 오프라인과 재연결

캐시는 인증된 PC identity+project+session+revision별 마지막 수신 snapshot을 갖는다. 대화·문서·작업 상태에 마지막 동기화 시점을 표시한다. 없는 내용은 아직 동기화되지 않음으로 표시하고 최신 진행을 추정하지 않는다. 기획 편집·검토 승인·AI/터미널 실행은 연결을 요구한다.

미전송 메시지 초안은 draftId, 대상 PC/project/session, text, 첨부 참조, modifiedAt으로 별도 저장한다. 기존 모바일 보안 저장 정책을 따르며 plaintext layout에는 넣지 않는다. 앱 강제종료 후 복구한다. 캐시되지 않은 첨부는 미확인으로 표시한다.

재연결 순서: PC identity 확인 → 이미 보낸 미확정 command receipt 대조 → 최신 snapshot 동기화 → 초안과 대상 표시 → 사용자 전송. PC 변경·세션 삭제·첨부 만료면 전송을 보류하고 대상 재선택을 요구한다. 연결되었다는 이유로 초안이나 이전 명령을 자동 보내지 않는다. 정상 연결 중 보낸 메시지의 ack만 유실된 경우는 미전송 초안으로 복제하지 않는다.

## 8. Scene 공통 요소·자산·상태

ScreenScene는 stable elementId, frame/platform, layout constraints, semantic roles, states, transitions, component references, assets, revision을 갖는다. 지원 요소는 기존 frame/text/input/button/list/table/tabs/dialog이며 임의 app-chrome script 실행은 허용하지 않는다.

ComponentDefinition은 componentId+version, 허용 속성, variant/state, slot, 구조를 소유한다. 초안 인스턴스는 공통 원본 변경을 따르고 overrides에 기록한 속성만 예외로 보존한다. 확정본은 component version·asset hash를 고정한다. 원본 변경은 연결 초안과 영향 목록을 하나의 revision 검사된 변경 묶음으로 적용하고 undo도 같은 묶음에 적용한다. 편집 충돌이 있는 인스턴스는 건너뛰어 성공으로 숨기지 않고 충돌·미반영으로 표시한다.

AI 패치는 선택 범위·허용 속성만 바꾸며 요청과 무관한 수동 편집을 보존한다. 제거된 속성과 overrides가 충돌하면 영향 비교를 보여 준다. 구조 변경으로 깨진 화면 링크는 검토 필요로 남긴다. 공통 원본에서 분리하는 동작은 명시적이며 원본 provenance를 유지한다.

Desktop과 Android는 동일한 기능/상태 ID를 공유해도 각각 다른 frame/layout을 가진다. min/max·fill/hug/fixed·stack/grid·overflow 규칙으로 폭 변화 동작을 명세한다. 기본, loading, empty, validation, disabled, error, success, offline 상태와 keyboard/touch 전이를 scene에서 정의한다. 폰트·이미지는 project asset reference로 관리하고 파일 없음/지원 없음/fallback을 표시한다.

왕복 검증은 복잡한 대표 화면 1개로 AI 생성 → 수동 수정 → 선택 요소 AI 수정 → 공통 요소 변경 → 예외 보존 → 폭·상태 전환 → export/import → IDs·참조·asset hash·시각 비교까지 수행한다. 보기용 PNG export는 편집 가능한 scene import를 대신하지 않는다.

## 9. 구현 인계와 검토 경계

W01은 위 공통 상태·버전·백업·lease 계약을 먼저 고정한다. W02/W03는 빠른 작업과 오프라인 draft, W04는 영향 분석, W05는 scene, W06은 profile·repair·대체 AI·환경 관리, W07은 revision 검토·통합, W08은 백업·수동 정리, W09는 양쪽 플랫폼 왕복/이전/복구 실증을 맡는다. [정책별 담당과 수용 기준](POLICIES.md)을 각 작업의 완료 기준으로 사용한다.

설계 패키지의 fixture 버튼·캡처는 사용흐름 설명이다. runtime correctness·보안 저장·프로세스 격리·실제 기기 복구를 검증한 증거가 아니다. 사용자 정책 확정과 전체 화면 검토, 제품 구현·검증 완료를 별도로 기록한다.
