# 기획 이후 단계의 설계와 구현 인계

상태: delivery-01 · r3에서 작성하고 r6 승인 기준에 포함했다. [승인 기록](APPROVAL.md). 이 문서는 실제 제품 구현·AI 실행·출시 검증 결과를 증명하지 않는다.

[예상 화면과 함께 보기](index.html#delivery) · [단계별 입력·산출물](DELIVERY-STAGES.md) · [역할별 지시](AI-PROFILES.md) · [작업 인계](HANDOFF.md)

## 두 흐름의 구분

이 제품을 쓰는 사람의 흐름은 설계 확정 → 실행 준비 → 작업 배정 → 구현 → 검증·검토 → 로컬 통합이다. 후보 비교는 선택한 팀 방식에서만 거치는 분기이며, 출시 준비는 사용자가 패키징·출시 범위를 요청한 경우 이어지는 단계다. 빠른 수정·일반 대화·실제 터미널은 전체 기획을 강제하지 않는다.

EZTerminal 2.0 자체를 만드는 순서는 [제작 로드맵](ROADMAP.md)의 G1–G8이다. 이 작업의 출시 범위에는 Windows와 Android가 모두 포함된다. G4 화면 편집과 G5 AI 실행은 G3 이후 병렬 진행할 수 있고, G2의 Windows·Android 작업도 공통 계약 이후 병렬 진행한다. 공통 계약·같은 파일을 동시에 변경하지 않는다.

별도 제품 로드맵·간트 메뉴를 만들지 않는다. 출시 자료도 D24 통합 상세와 기존 파일·도구·외부 연결로 확인하며 새로운 배포 서비스나 자동 발행 기능을 추가하지 않는다.

## 단계 사이에 넘기는 계약

다음은 구현할 계약의 필수 의미다. 정확한 파일 위치와 기존 타입 재사용은 W01이 시작 시 최신 코드를 조사해 결정한다. 런타임에 이미 존재한다는 뜻이 아니다.

| 계약 | 필수 필드와 의미 | 변경·검증 규칙 |
| --- | --- | --- |
| PlanningReference | 항목 ID, 종류, revision, 원본 위치, 해시 | 초안 참조와 확정 참조를 구분. 참조 변경으로 기존 실행 입력을 교체하지 않음 |
| RunDefinition | runId, baselineId, baseRevision, scope, teamMode, progressionPolicy, profileSnapshots, perTaskOverrides, terminalCondition | 준비 이후 입력 묶음 고정. 사용자 시작과 권한 점검 이후에만 배정 |
| TaskDefinition | taskId, runId, featureIds, screenIds, inputRefs, dependencyIds, allowedPaths, interfaceRefs, acceptance, validationPlan | 각 조건에 검증 수단·담당 지정. DAG 검증 및 쓰기 범위 중복 검사 |
| ExecutionAttempt | attemptId, taskId, dispatchId, sessionId, workspaceId, baseRevision, requestedSettings, effectiveSettings, promptVersion, contextRefs, status | 재시도는 새 ID. 완료 수락 시 현재 dispatch와 결과 revision 확인 |
| Question | questionId, taskId, attemptId, 내용, 선택지, 필요한 결정, 상태, 답변 revision | 중복 전송 병합. 오래된 시도의 질문은 현재 실행에 자동 적용하지 않음 |
| Evidence | evidenceId, acceptanceId, artifactRevision, baselineId, environment, command, startedAt, finishedAt, exitCode, status, logRefs, captureRefs | passed / failed / not-run / cancelled / stale 구분. 명령·기기·버전·대상 누락 시 필수 근거로 인정하지 않음 |
| ReviewDecision | decisionId, reviewerSessionId, baselineId, artifactRevision, evidenceIds, decision, notes | 작성자와 분리된 검토. reviewed / changes-requested / blocked 구분. 대상 변경 시 stale |
| CandidateSelection | candidateId, taskId, sharedBaseRevision, artifactRevision, rationale | 채택만 기록. 검토·통합 명령과 분리 |
| IntegrationResult | integrationId, baseRevision, orderedInputs, candidateRevision, lastSuccessfulRevision, validationRefs, status | 통합 중 일부 성공은 전체 성공이 아님. 검증된 후보만 성공 지점으로 채택 |
| ReleaseReadiness | sourceRevision, platformArtifacts, versions, hashes, installEvidence, migrationEvidence, recoveryEvidence, knownIssues | 요청한 플랫폼의 필수 근거 전부 통과해야 ready. main 반영·push·발행은 별도 명령 |

명령 envelope에는 commandId, projectId, expectedRevision, 실행 주체와 권한 범위를 포함한다. 같은 commandId의 재전송은 같은 결과를 돌려준다. 미확정 요청은 호스트 기록으로 대조한다. revision 충돌·미지원 기능·연결 유실·권한 부족은 구별되는 오류와 복구 행동을 제공한다.

## 실행과 완료의 의미

작업 상태는 draft → ready → queued → running → awaiting-review → accepted → integrated로 진행한다. 선행 작업·설정·답변 때문에 진행할 수 없으면 blocked이며, blockedReason과 복귀 조건을 기록한다. failed와 cancelled는 해당 시도의 종료 상태다. 재시도는 이전 결과를 보존한 새 시도를 만든다.

작업자의 worker_done은 결과 제출이다. 호스트의 검증과 독립 검토가 끝나기 전에는 accepted가 되지 않는다. 각 단계의 독립 검토는 W09 최종 검토와 별개로 수행한다. 담당 모델이 같더라도 검토 세션과 지시는 분리한다.

실행 정지는 새 배정의 일시정지와 진행 중 turn 취소를 구분한다. 취소 확인 전에는 취소 중으로 표시한다. PC가 재시작되면 running을 성공·실패로 추정하지 않고 세션·명령·작업 사본을 대조한다. provider-native 자식은 제공자가 허용하는 읽기·관찰 범위만 노출한다.

단계별 검토 정책은 단계가 끝나면 사용자 판단을 기다린다. 자율 정책도 작업 검증·독립 검토를 건너뛰지 않으며, 로컬 통합과 검증 완료에서 종료한다. 설정을 편집해도 진행 중 시도의 모델·지시는 바뀌지 않는다. Windows·Android 구현 담당은 같은 구현 프로필을 상속하되 실행 준비에서 각 담당의 모델을 따로 지정할 수 있다. 한 담당의 변경이 다른 담당에 전파되지 않는다.

## 통합·부분 실패·복구

1. 검토된 입력들의 정확한 revision과 현재 통합 기준을 다시 확인한다.
2. 직전 성공 지점에서 별도 통합 후보를 만든다. 사용자의 현재 작업 폴더와 미커밋 변경은 보존한다.
3. 의존 순서로 입력을 적용한다. 충돌·설정 변경·근거 만료가 생기면 해당 후보를 멈춘다.
4. 통합 후 필수 검사를 수행한다. 작업별 검사 통과만으로 통합 통과를 대신하지 않는다.
5. 검사에 통과한 후보만 새 성공 지점으로 채택한다. 실패 후보·로그·이미 통과한 작업의 근거는 남긴다.
6. 복구는 직전 성공 지점으로 새 후보를 만들거나 실패 범위를 수정하는 방식이다. 무조건 reset·삭제·사용자 파일 덮어쓰기를 하지 않는다.
7. 기준이나 공유 계약 변경으로 영향을 받은 후속 작업은 stale로 표시하고 재검토·재검증 범위를 산출한다.

릴리스 준비의 복구는 코드 통합 복구와 별개다. 앱 데이터 schema가 바뀌었으면 실행 파일만 되돌리지 않는다. 이전 전에 만든 데이터 백업과 해당 버전 앱으로 복원하는 절차를 실제 복사 환경에서 확인한다. 인증 정보는 기존 보안 저장소 정책을 따르고 검증 로그에 노출하지 않는다.

## EZTerminal 제작 단계별 검증

아래 명령은 향후 제품 구현의 검증 계획이다. 이번 설계 작업에서 실행하거나 통과했다고 주장하지 않는다. 실제 변경 범위와 저장소 최신 스크립트를 확인한 뒤 필요한 검사를 선택한다.

| 단계 | 필수 근거 | 사용할 검증 경로 |
| --- | --- | --- |
| G1 계약·저장 | 이전 데이터 복원, revision 충돌, 명령 중복·재시작 | pnpm typecheck, 관련 Vitest 및 host/OS 검사 |
| G2 대화·탐색 | 두 스킨의 동일 transcript, 입력·IME·세션 보존, Android 재연결 | 관련 Storybook·시각 검사, pnpm e2e, mobile typecheck·test·기기 흐름 |
| G3 기획 | AI/manual 편집·undo, 참조 영향, baseline 불변, 권한 제한 | 관련 단위·통합 검사, 두 플랫폼 편집·복구 e2e |
| G4 화면 편집 | scene 범위, 참조·상태 이동, 키보드·터치 조작 | scene 검사, Storybook·시각 검사, 관련 e2e |
| G5 AI 실행 | 모델 지원 검증, 실제 적용 설정, 의존성·상한·재시도·질문·복구 | host scheduler/provider 계약 검사, 관련 e2e |
| G6 검토·통합 | 근거·검토 만료, 파일 충돌, 통합 부분 실패·성공 지점 복구 | 파일·Git 통합 검사와 Windows·Android 검토 흐름 |
| G7 기존 기능 | 기존 기능 대응표 전 항목과 외부 동작 경계 | 관련 기능 검사, pnpm e2e, 모바일 대응 흐름 |
| G8 종합·패키징 | 전체 필수 회귀, 버전 일치, 설치·업데이트·이전·복구 | pnpm typecheck, pnpm test, pnpm e2e, 관련 Storybook/visual, pnpm test:e2e:packaged, pnpm verify:version |

Android는 mobile의 typecheck, test, build:release, WebView74·production 검사와 실제 기기의 smoke·session-restart·stabilization·handoff 흐름 중 변경에 관련된 검사를 수행한다. 패키지는 기존 Windows package/make 및 Android release 경로를 사용하며 버전·서명·source revision·해시를 보고서에 남긴다. 플랫폼이나 기기를 사용할 수 없으면 미실행으로 남기고 해당 단계 완료를 보류한다.

성능 측정은 명시적 별도 요청이 있을 때만 한다. 일반 개발 검증 pnpm e2e에 성능 benchmark를 추가하지 않는다.

## 출시 준비 체크와 작업 인계

| 항목 | 통과 근거 | 실패 시 |
| --- | --- | --- |
| 같은 기준의 결과물 | Windows·Android source revision과 version 계약 일치, 산출물 해시 | 다시 패키징하고 관련 검증 |
| 새 설치 | 깨끗한 환경 실행·기본 설정·프로젝트·대화·터미널 확인 | 설치 원인 담당으로 복귀 |
| 기존 설치 업데이트 | 기존 데이터 복사본으로 설정·세션·workspace·기록 보존 | 이전 중지, 원본 보존, 복구 검증 |
| 기획 데이터 이전 | .ezterminal/planning 원본·baseline·참조·검토 기록 무결성 | 손상 범위 격리, 백업 복원 |
| Android 호환 | 지원 WebView·설치/업데이트·Back·IME·재연결·강제 종료 복구 | 모바일 담당 수정 및 실기기 재검증 |
| 실패 후 복구 | 의도적으로 중단한 이전·설치 후 마지막 정상 데이터·버전으로 복구 | 출시 준비 미완료 |
| 외부 반영 준비 | 알려진 문제·검증 보고서·변경 요약·설치 파일 위치 | 남은 결정 표시. 자동 merge/push/publish 없음 |

각 작업 인계에는 입력 revision, 소유 파일·계약, 변경 결과, 실행한 검사와 미실행 이유, 재현 절차, 검토 결과, 통합 순서를 포함한다. [HANDOFF.md](HANDOFF.md)의 W01–W09가 구체 입력·출력·인터페이스·실패 복귀를 소유한다. 인계서의 완료 표현은 실제 실행 근거가 확보된 뒤에만 사용한다.

## 검토 순서와 남은 결정

1. [기획 이후 단계](index.html#delivery)에서 정상 경로와 실패 복귀를 본다.
2. D15에서 팀 방식·진행 정책·역할 설정을 체험하고, 미지원 모델 선택 시 시작이 막히는지 본다.
3. D17/D19/D20에서 시도·후보·검증·검토의 차이를 확인한다.
4. D24에서 통합 결과·출시 준비·충돌 복구를 전환한다. M07/M08/M15에서 모바일 대응을 본다.
5. 제작 로드맵과 W01–W09 인계를 확인한 뒤, 전체 설계의 수정 의견을 남긴다.
6. 사용자 검토가 끝나고 해당 설계 버전이 확정되면 구현을 시작한다.

2026-10-13 후속 전체 지시로 r6 설계 검토와 구현 진행 승인이 확정되었다([승인 근거](APPROVAL.md)). 실제 프로젝트의 provider/model 연결, 제품 구현과 검증은 실행 단계의 작업이며 이 문서나 프로토타입의 예시 버튼이 완료를 대신하지 않는다.



## r4 운영 정책과 인계

2026-10-13 확정한 [11개 운영 정책](POLICIES.md)을 반영한다. 상세 상태·Task/Session/Turn 연결·변경 계획·재시도·프로필·환경 격리·백업·Android 초안·Scene 공통 요소는 [POLICY-CONTRACTS.md](POLICY-CONTRACTS.md)를 따른다. [정책별 화면](index.html#policies)에서 정상·대기·복구를 단계별로 검토한다. r6 전체 설계 승인 이후 실제 제품 구현·검증은 별도 근거로 확인한다.
