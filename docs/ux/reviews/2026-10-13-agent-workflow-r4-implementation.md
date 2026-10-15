# r4 구현 검수 기록

상태: 승인 범위 구현 및 사용 가능한 환경의 통합 검수 완료. 검수 중 발견한 항목은 수정·재검증했다.
물리 기기 IME, native plugin 관리의 모든 조합과 실제 provider의 전체 실행 그래프 완주는 미검증이다.
이 기록은 공개 출시·설치판 업데이트 승인 기록이 아니다.

사용자는 [r4 설계](2026-10-13-agent-workflow-r4-approval.md)를 승인하고 구현을 멀티에이전트,
이 세션을 검수 담당으로 지정했다. 기존 작업 트리 기준은
`artifacts/r4-implementation-review/baseline-inputs.json`과 같은 폴더의 `baseline/`이다.

## 담당 범위

| 담당 | 구현 또는 검수 범위 |
| --- | --- |
| capabilities | 턴 없는 provider 기능 조회, native 확장 관리, 공통 채팅 연결 |
| workflow_domain | 소프로젝트 저장·명령·이전, 실행 원장 연결, 앱 내 AI 도구, IPC·원격 API |
| workflow_ui | Desktop·Android 진입, 생성·그래프·단계 대화·실행 화면 |
| root | 승인 기록, 기존 변경과 비교, 경계·회귀·시각 검수, 결과 기록 |

## 검수 요청 목록

아래는 구현 중 전달한 검수 요구와 최초 요청 상태다. 최종 해결 근거는 문서 끝의 ‘최종 판정’에 둔다.

| ID | 확인할 동작 | 상태 |
| --- | --- | --- |
| R01 | 기존 기획 파일 바이트·baseline hash·receipt 유지, scope는 host에서 ID로 해석 | 구현 중 |
| R02 | 분기·합류·재시도의 이번 activation 결과만 사용, 과거 분기 결과 재사용 금지 | 구현 중 |
| R03 | AI 되돌리기가 이후 무관한 변경을 보존하고 충돌을 알림 | 보완 요청 |
| R04 | 실행 반영 뒤 파일 저장 실패 시 동일 commandId로 조회·복구, 중복 dispatch 방지 | 보완 요청 |
| R05 | 생성·편집·복원에서 같은 ID 불변식, 기존 기획의 후속 baseline 소속 유지 | 보완 요청 |
| R06 | 일반 대화와 단계 연결에서 같은 session 유지, 선택 화면으로 소속을 추정하지 않음 | 구현 중 |
| R07 | 입력·스크롤·복귀 위치 보존, 보관 단계의 Enter 전송 차단 | 구현 중 |
| R08 | 모델 선택·기본값 안내·권한 선택이 실제 실행 지원과 일치 | 보완 요청 |
| R09 | 편집 중 빈 줄 보존과 저장 시 정규화, 노드 종류에 맞는 편집 필드 | 보완 요청 |
| R10 | 첫 조회에 model submit 없음, 설치/활성/오류/미지원 상태 구분 | 구현 중 |
| R11 | 관리 전 재조회에서 안정적 revision, CLI 옵션 주입 방지, 실제 앱 도구만 광고 | 보완 요청 |
| R12 | native 설정 공유, Android host·권한·미확정 결과 복구, draft 보존 | 구현 중 |
| R13 | 단계의 결과 참조를 이번 upstream attempt·산출물·worktree에 연결 | 보완 요청 |
| R14 | 대화로 구성 시 AI 결과가 생성 전 미리보기에 반영, JSON 수동 전달 제거 | 보완 요청 |
| R15 | 일반 대화에서 새 소프로젝트 생성·단계 연결을 같은 세션으로 완료 | 보완 요청 |
| R16 | 실행 중 실제 작업 세션 열기, 승인 대기 중 일시정지, 읽을 수 있는 한영 상태명 | 보완 요청 |
| R17 | 그래프 실행에서 기존 자동 통합을 차단하고 명시적 통합만 허용 | 보완 요청 |
| R18 | 기존 문서 AI 제안·assets·초안 복구·확정본·백업의 소프로젝트 범위 격리 | 보완 요청 |
| R19 | 생성 미리보기의 단계 구분, 기본 프리셋의 실패→수정→재검토 흐름 | 보완 요청 |
| R20 | 재시도 범위 밖의 유효한 입력 유지와 범위 안의 과거 결과 배제 | 보완 요청 |
| R21 | 단계 대화의 저장된 문서·결과 참조를 실제 턴에 고정하고 명시적으로 갱신 | 보완 요청 |
| R22 | 취소·완료·보관·결과 검토·명시적 통합의 후속 동선 | 보완 요청 |
| R23 | 선택 작업 범위의 준비와 소프로젝트 복사, 이전 protocol의 모든 쓰기 경계 | 보완 요청 |

## 관찰한 검증

- 승인 이후 `pnpm docs:check`: 활성 계약 10개, 보관 문서 19개, 상대 링크 367개 통과.
- 승인 자료 4개와 r1–r4 시안 파일 524개: 총 528개 SHA-256 일치.
- 위 결과는 문서·원본 보존 확인이다. 제품 코드, 실제 provider, Android 기기 검증으로 간주하지 않는다.

### 첫 구현 연결 검사

- `pnpm typecheck` 1차: 실패(exit 2). Android capability transport 누락, MCP agent nullable,
  runtime bridge source 타입 누락, 실행 snapshot의 readonly 배열, graph preset tuple 오류를
  각 구현 담당에 전달했다. 로그: `artifacts/r4-implementation-review/typecheck-integration-1.log`.
- `pnpm lint` 1차: 실패(exit 1), 오류 3개·경고 5개. 신규 코드의 미사용 변수/import와 제어문자
  정규식, hook 의존성을 담당에게 전달했다. 기존 daemon-authority test의 중복 import 경고는
  이번 변경과 분리한다. 로그: `artifacts/r4-implementation-review/lint-integration-1.log`.
- 실제 provider metadata probe: Codex 0.162.1에서 모델 7개·스킬 20개·플러그인 6개·MCP 4개,
  catalog issue와 adapter event 없음. Claude SDK 0.3.260에서 모델 12개·명령 93개·MCP 7개,
  input generator 전달 0개·system 메시지 4개. 사용자 메시지·native 설정 쓰기 없음.
  Claude 결과는 별도 SDK control protocol 증거이며 제품 동의 경계를 통과한 실행 증거는 아니다.
  원본: `artifacts/r4-implementation-review/native-capabilities.json`, 같은 폴더의
  `probe-agent-capabilities.ts`.

제품 구현이 안정된 시점에 타입·린트·관련 단위/host·Storybook·시각·일반 E2E 결과를 추가한다.
성능 벤치마크는 요청되지 않았으므로 실행하지 않는다.

### 초기 화면·첫 전송 검수

- production workflow Storybook 6개 상태를 Playwright로 확인했다. 각 상태에서 JS 오류 0,
  WCAG 2 A/AA·2.1 A/AA 자동 검사 위반 0, 문서 가로 넘침 0을 관찰했다. 생성 창은 Escape로
  닫혔다. 결과는 `artifacts/r4-implementation-review/visual-first/report.json`에 기록했다.
  이는 실제 IPC·전체 앱·Android 기기 검증이 아닌 독립 component story 검사다.
- 생성·프로젝트 목록·모바일 목록·좁은 화면 캡처를 승인 r4 원본과 나란히 검토했다.
  생성 프리셋 단계가 한 줄에 붙는 문제, 한국어 화면의 원시 연결 상태명, 기본 프리셋의
  검토 실패 분기 누락을 담당에게 전달했다. 원본 및 snapshot은 갱신하지 않았다.
- 기존 provider 승인 기록과 임시 프로젝트를 사용한 실제 Codex 첫 전송에서 사전 transcript 0,
  스킬 조회 성공, 제출 1회, completed 및 스킬의 확인 문구를 관찰했다. tool call 0,
  사용자 native 설정·제품 동의 변경 없음. Claude는 실행 파일과 기존 승인 정보 불일치로
  제출 0회 차단됐다. 근거: `artifacts/r4-implementation-review/native-first-turn.json`.

### 회귀·확장 화면 1차

- 전체 `pnpm test:unit`: 364 파일·3,337 테스트 통과, 1 파일·5 테스트 건너뜀, exit 0.
  구현 중 실행한 결과이며 이후 변경까지 보증하지 않는다. 로그: `unit-integration-1.log`.
- root lint 2차: 오류 0·경고 4. root typecheck 2차: 추가 복구 API 연결과 archive 테스트의
  메서드 이름, optional 접근 오류로 실패. 담당에게 전달했다.
- mobile lint 1차: 오류 0·경고 7. mobile typecheck 1차: selected skill 배열의 readonly
  경계 오류로 실패. mobile unit 1차: 572 통과·3 실패. 실패는 새 프로젝트 진입 구조에서
  기존 `planning-workspace`를 곧바로 기다리던 테스트이며, 기존 권한·초안 보존 조건을
  유지한 채 새 동선을 확인하도록 담당에게 전달했다.
- capability production story 5개: JS 오류 0·가로 넘침 0. 새 대화 입력 textarea에서
  접근성 label 위반 1개를 관찰해 수정 요청했다. 나머지 4개 story 자동 접근성 위반 0.
  원본: `artifacts/r4-implementation-review/capabilities-visual-first/report.json`.
- 격리된 native 설정 폴더에서 Codex·Claude의 MCP 추가→조회→제거→부재 확인 성공,
  모델 턴 0·사용자 설정 fingerprint 변화 없음. 근거: `native-extension-management.json`.
- Android API 29는 root 소유의 읽기 전용 emulator-5584를 시작했다. 이 기록은 APK
  시나리오 통과가 아니며, 물리 기기는 연결되지 않았다.

### 후속 통합 검수

- root `pnpm typecheck` 3·4차와 mobile typecheck 2차 통과. OS 검사 5개 파일·38개 테스트 통과.
  root lint 3차 오류 0, 기존 daemon-authority 테스트의 중복 import 경고 2개.
- capability production story 6개를 재검사했다. textarea label 수정 후 모든 상태에서 JS 오류,
  자동 접근성 위반, 문서 가로 넘침 0. `capabilities-visual-second/report.json`에 기록했다.
- workflow production story 6개도 재검사했다. `visual-third/report.json`의 같은 검사 통과.
  생성 창의 입력/미리보기 2열을 실제 캡처로 확인했다. 실제 앱의 초기 캡처는
  `real-app/`에 있으며 생성 창 수정 이전 이미지와 구분한다.
- 전체 Storybook 38개 파일·234개 테스트 중 232개 통과, 2개 실패. 새 목록의 provider suffix
  matcher와 기존 기획 오프라인 화면의 없는 tabpanel 참조를 수정한 뒤 해당 2개 파일·13개 테스트 통과.
  로그: `storybook-integration-2.log`, `storybook-integration-3.log`.
- mobile 단위 검사 2차 58개 파일·581개 테스트 통과. 이후 cold offline 복구 변경은 별도 재검증한다.
- mobile release 웹 빌드, WebView 74 호환성, production E2E marker 부재 검사 통과.
  이는 APK 설치·재시작 시나리오의 통과를 뜻하지 않는다. 로그: `mobile-build-release-1.log`.
- Project Map 시각 회귀에서 architecture/dataflow의 dark-en/light-ko 4쌍을 원본과 나란히
  검토했다. v13/v12 설명·라벨 변경과 그에 따른 배치 조정이 차이의 원인이다. 이 4개 snapshot만
  담당 에이전트에게 갱신을 허용했으며 고정 desktop handoff·r4 시안은 갱신 대상이 아니다.
- Claude 격리 프로필의 정상 승인 이후 첫 대화 생성 timeout을 재현했다. native 초기화 metadata는
  제공되지만 첫 메시지 전 system/init을 기다리던 경계가 원인이었다. 담당 에이전트의 수정과
  실제 첫 전송 성공 보고를 받았으며 원본 증거를 검수한다. 원래 사용자 프로필은 변경하지 않았다.

### 실제 provider·APK 후속 검수

- 전체 단위 검사 2차는 370개 파일·3,373개 테스트 통과, 1개 파일·5개 테스트 건너뜀이다.
  이후 MCP metadata, 대화 생성 복구, 모바일 호환성 수정은 별도 검사한다.
  로그: `unit-integration-2.log`.
- `native-claude-isolated-profile.json`을 root가 읽어 정상 승인된 격리 프로필에서
  첫 전송 1회·완료·확인 문구를 검증했다. 기존 사용자 프로필의 승인·설정은 변경하지 않았다.
- `native-workflow-preview.json`에서 실제 Codex가 앱의 인증된 MCP를 통해
  `workflow_read`와 `preview_workflow`를 호출했다. 사용자 메시지 1회와 단일 호출 승인 2회,
  미리보기 revision 1과 제목 변경을 확인했다. 저장된 소프로젝트와 실행은 모두 0개였다.
  이 검사는 모델이 작업을 실행한 증거가 아니라 생성 전 미리보기를 수정한 증거다.
- 실제 MCP 호출에 포함되는 `_meta`를 잘못 거부하던 문제와 Codex의 단일 MCP 도구 승인
  형식을 담당 에이전트가 수정했다. MCP metadata는 도구 인자나 권한으로 사용하지 않는다.
  native plugin의 모든 설치·업데이트 조합은 실제 검증하지 않았으며 MCP 추가·조회·삭제와 구분한다.
- `native-capabilities.json`은 재검사되어 현재 Codex 모델 7개·스킬 49개·플러그인 6개·MCP 3개,
  Claude 모델 12개·명령 93개·MCP 7개를 기록한다. 앞 절의 수치는 초기 관찰값이다.
  두 카탈로그 조회 모두 모델 턴 0이다.
- 전체 시각 회귀 86개 중 76개 통과, 10개 실패를 관찰했다. 지도 4개는 변경된 의미·protocol
  설명, 모바일 5개는 세션 시작 전 소스에 대한 낡은 snapshot, desktop 설정 1개는 HMR 중
  execution context 소멸이었다. 마지막 항목은 이미지 차이가 아니므로 snapshot 갱신하지 않는다.
- 지도는 v13 설명을 최종 승인하지 않았다. 실제 protocol v14와 v13 planning·v12 daemon
  호환 범위를 수정한 후 `map-v14-visual-actual/`의 expected/actual 4쌍을 root가 다시 검토했다.
  architecture/dataflow의 dark-en/light-ko 4개만 갱신 승인했다.
- 모바일 기존 snapshot 5개는 소스의 baseline hash 일치를 확인하고 각 expected/actual을 나란히
  검토한 뒤 갱신했다. 이전 이미지와 hash는 `visual-reviewed-prior/manifest.json`에 보존했다.
  고정 handoff와 승인 시안 원본은 수정하지 않았다.
- API 29 읽기 전용 emulator의 실제 WebView는 Chrome 74.0.3729.185였다. 첫 APK harness는
  CDP 문자열의 optional chaining 구문에서 실패했다. `android-js-engine.json`으로 같은 엔진의
  SyntaxError를 재현한 뒤 테스트 문자열을 고쳤다.
- 두 번째 APK의 `android-r4-second/planning-workflow-report.json`은 데이터 검사 7단계 통과와
  정리 오류 0을 기록한다. 실제 모델 턴은 0이며 검토용 fake Codex 초기화를 사용했다.
  다만 root가 실제 화면을 열어 아래 제품 문제를 발견했으므로 APK 수용 완료로 판정하지 않는다.
  - 단계 대화 왕복 중 `Promise.allSettled is not a function` 표시.
  - 대화 연결만 바뀌어도 편집 중 그래프에 불필요한 동시 수정 경고 표시.
  - cold offline 복구에서 접속 불가를 오래된 PC 버전으로 잘못 안내하고 오프라인 경고 중복.
  - Chrome 74의 flex gap 미지원으로 버튼이 붙음. 실제 probe는 토큰·computed gap 8px,
    자식 요소 사이의 실제 간격 0px를 기록했다.
- 위 문제는 UI 담당에게 반환했다. 최종 APK에서는 예외 표시 부재와 재연결 후 자동 저장·실행
  부재를 검사하고, 캡처를 직접 다시 검토한다. 물리 Android 기기와 실제 IME 조작의 전체 검증은 아니다.
- root typecheck 5차는 remote bridge 테스트의 optional requestId 타입 가드 때문에 실패했다.
  담당 수정 후 해당 테스트 169개 통과 보고를 받았으며 전체 타입 검사를 다시 수행한다.
- 일반 `pnpm e2e`는 성능 opt-in 환경 변수가 없는 것을 확인한 후 143개 테스트로 실행 중이다.
  성능 벤치마크는 포함하지 않았다.

### 최종 보완 확인 중

- 일반 E2E 1차 완료: 143개 중 137개 통과·6개 실패, 24.3분. 새로운 소프로젝트 저장·재시작과
  일반 대화의 같은 세션 연결·미전송 입력 보존·앱 도구의 생성 전 미리보기 수정은 통과했다.
  로그: `e2e-integration-1.log`. 아래 실패 6개는 수정 후 실제 앱에서 다시 검사한다.
  - 기존 기획 archive inventory 1개: 가상 legacy metadata의 시각이 매번 바뀌던 제품 오류.
    기존 기록 시각 또는 원본 파일 mtime을 사용하고 hash 변경 감지와 원본 바이트는 유지했다.
    담당자의 저장·archive·IPC 25개 회귀 검사 통과를 확인했으며 E2E는 재검증 전이다.
  - Project Map 1개와 Project Workbench 4개: 테스트가 이전 기획 화면에 직접 진입한다고 가정했다.
    새 프로젝트 목록에서 `Quick tasks and existing work`를 거치도록 테스트 진입만 수정했다.
- Codex에 이어 Claude의 실제 앱 도구 호출도 root가 원본 JSON으로 검수했다.
  `native-claude-workflow-preview.json`: 명시 메시지 1회·완료, `workflow_read`와 `preview_workflow`,
  승인 2회, preview revision 1, 저장된 소프로젝트·실행 0개. 원본 제품 동의 및 native 설정의
  전후 fingerprint가 일치했다. 실제 모델이 실행 그래프 전체를 수행한 검사와 구별한다.
- root typecheck 6차 통과. 이는 아래 R13 추가 보완 이전 결과다.
- 최신 mobile 전체 검사: 58개 파일·586개 테스트 통과. 로그: `mobile-unit-final.log`.
  root의 `test:unit` 호출은 mobile에 없는 script 이름이라 먼저 실패했으며,
  실제 정의된 `pnpm -C mobile test`로 실행한 결과다.
- mobile release 웹 빌드 3차는 production E2E marker 부재와 WebView 74의 13개 fallback 계약,
  10개 API family 검사를 통과했다. E2E 웹 빌드·Capacitor sync·debug APK 빌드도 exit 0이었다.
  최신 APK에서 실제 화면과 재연결 이후 자동 제출 부재를 재검증할 예정이다.
- 갱신 승인된 모바일 5개 시각 검사 통과. desktop handoff 설정 화면은 안정된 서버에서 동일
  snapshot·접근성 검사 통과(`visual-settings-final.log`), 원본과 snapshot을 변경하지 않았다.
  그 이전 blank document 실패 중 Storybook 서버가 `mobile/dist/index.html`과 Playwright trace
  HTML을 감지해 full reload한 로그를 발견했다. 검사 환경의 감시 제외 경로를 보완한다.
- 지도 4개는 갱신 후 별도 4개 재검사 통과. 의미 검사는 Project Map 7개 통과다.
- 최종 도메인 대조에서 R13의 추가 누락을 발견했다. 기획·조사의 실제 텍스트 결과 대신
  attempt와 artifact 식별값만 다음 단계에 전달될 수 있었다. 현재 회차의 승인된 결과 본문을
  검증해 전달하고 과거 회차·미선택 결과를 제외하도록 담당에게 보완을 요청했다.
  이 항목이 확인되기 전에는 전체 구현 완료로 판정하지 않는다.

## 최종 판정

R01–R23의 구현 중 발견 항목은 아래 근거로 해결 확인했다. 이전 절의 실패·진행 중 상태는 당시의
관찰 기록으로 보존한다. 기존 r3/r6의 공통 채팅, 기획 편집, 실행 원장·attempt·독립 검토·통합 경계를
재사용하며 새 소프로젝트가 기존 문서·baseline·대화를 대체하지 않는다.

| 요청 | 해결 확인 근거 |
| --- | --- |
| R01·R05 | `workflow-service`의 legacy 원본 바이트·baseline 소속·ID 검사·동일 시각 투영. 실제 기획 archive·재시작 E2E 재통과 |
| R02·R13·R20 | frozen graph의 activation ancestry, 현재 attempt/독립 검토/artifact 대조. 실제 Git의 읽기 전용 본문 capture와 실제 host·DB의 두 단계 dispatch에서 다음 provider prompt·durable turn에 본문 전달 |
| R03·R04 | 이후 무관 변경을 보존하는 보상 undo, 겹친 변경 거절. 저장 실패 이전 pending intent와 동일 command receipt로 submit 중복 방지 |
| R06·R07·R15·R21 | 같은 일반 session을 단계에 연결하고 입력·문서·복귀 유지. 실제 Desktop E2E와 API 29 APK 통과. 저장 참조는 명시 갱신 전 고정 |
| R08·R10·R11·R12 | 실제 Codex·Claude의 0턴 metadata·선택 스킬 첫 응답·앱 MCP 호출. 안정 revision·argv·remote 권한·암호화 생성/입력 복구 검사. native 설정 공유와 MCP 추가/조회/삭제는 별도 격리 설정으로 검증 |
| R09·R14·R19 | 노드별 편집 필드와 빈 줄 보존·저장 정규화, 프리셋의 실패 분기·유한 재시도. 실제 provider의 생성 전 preview 변경과 취소 시 무생성 확인 |
| R16·R17·R22 | 같은 worker/reviewer 세션 열기, pause·queued cancel·provider 취소 확인, 완료/보관 구분. 승인 대기와 완료 진입만으로 통합하지 않고 명시 통합 명령을 검증 |
| R18·R23 | scoped planning·AI 제안·assets·초안·결과·archive 격리, 선택 작업 의존성 closure, 새 ID 복사와 미확정 응답 복구, protocol 13 scoped 쓰기 거절 |

### 완료 시점 검사

| 검사 | 관찰 결과와 근거 |
| --- | --- |
| Root 타입 | `typecheck-integration-7.log` exit 0. R13 최종 main hook과 mobile E2E 타입 포함 |
| 최종 lint·문서 | Root lint 5차 exit 0·오류 0·기존 경고 2개, mobile lint exit 0. 문서 검사 활성 10개·보관 19개·상대 링크 367개 통과 |
| 전체 단위 및 재검사 | 3차 369개 파일·3,387개 테스트 통과, verifier fixture 1개 파일·2개 실패, 1개 파일·5개 skip. 새 allSettled 계약을 fixture에 반영하고 계약/구현 누락 부정 검사를 추가한 뒤 해당 파일 9개 전부 통과. `unit-integration-3.log`, `webview-verifier-fixture-green.log` |
| Mobile 단위 | 58개 파일·586개 통과. `mobile-unit-final.log` |
| OS | 5개 파일·38개 통과. `os-integration-1.log` |
| 일반 E2E | 전체 143개 중 137개 통과·6개 실패 후, 수정된 실패 6개를 포함한 16개를 최신 패키징으로 재실행하여 모두 통과. `e2e-integration-1.log`, `e2e-final-focused.log`. 단일 실행에서 143개 모두 통과했다고 표시하지 않는다 |
| Storybook | 전체 234개 중 232개 통과 후 실패 관련 2개 파일·13개 재통과. workflow 6개·capability 6개 production 상태의 별도 브라우저 검사에서 JS 오류·자동 접근성 위반·가로 넘침 0 |
| 시각 회귀 | 전체 86개 중 76개 통과 후 지도 4개·기존 모바일 5개·고정 desktop 설정 1개 모두 후속 검사 통과. snapshot 변경은 원본과 나란히 검토한 지도 4개·기존 모바일 5개에 한정 |
| 검사 환경 | 생성 HTML을 Storybook이 감시하여 reload하는 exact red 확보 후 생성물 경로만 감시 제외. 동일 파일 생성 뒤 10초간 추가 reload·JS 오류 0, ready 유지. `settings-watcher-green.json` |
| 제품 guard | design style 24 CSS·528 production source, 고정 handoff 14 surfaces·19 pinned files, Claude provider·승인 privacy·offline pairing guard 통과 |
| Project Map | R13 실제 본문 전달 경계를 재검토·근거 갱신 후 7개 모두 통과 |
| 원본 보존 | 승인 자료와 r1–r4 시안 528개 SHA-256 일치, 불일치 0. `immutable-final.json` |

### 최신 실제 APK

`android-r4-final/planning-workflow-report.json`의 7단계와 process exit 0, cleanup 오류 0을 확인했다.
API 29 / WebView 74에서 수동 저장, 오프라인 편집, force-stop 복구, 같은 대화 연결·미전송 입력·문서
왕복이 통과했다. 두 재연결 경로에서 각각 2초간 host revision·문서·실행이 자동 변경되지 않았다.
예기치 않은 화면 오류·JS 오류·충돌 경고 부재와 실제 버튼 간격 8px를 검사하고 root가 최종 캡처도 열어 확인했다.

- [Desktop 단계 대화 복귀](../../../artifacts/r4-implementation-review/real-app/stage-chat-return.png)
- [Android 단계 대화 복귀](../../../artifacts/r4-implementation-review/android-r4-final/r4-stage-chat-return.png)
- [Android 오프라인 복구](../../../artifacts/r4-implementation-review/android-r4-final/r4-offline-graph-restored.png)

검증 APK SHA-256: `0e973e439d0d8552df67a82523539d8d3b7def8b1063bb3917f4cee7265ee470`.
연결한 desktop main SHA-256: `a56f776877391ee58434fcb50025a1bdfceff49ace0a2fecb2501461411063f3`.
이 APK는 검증용 debug/E2E 빌드다. 별도로 release 웹 빌드의 E2E marker 부재를 확인했다.

### 확인한 범위의 한계

- Android는 읽기 전용 emulator-5584다. 최초 연결은 native tap, 주요 시나리오는 WebView DOM input/click을
  사용했다. 물리 기기·실제 IME·모든 시스템 Back/키보드 조합을 검증한 것은 아니다.
- APK는 검토용 fake Codex 초기화만 사용했고 실제 모델 턴은 0이다. 실제 두 provider의 첫 스킬 응답과
  MCP preview 수정은 별도의 native probe로 확인했다. native 모델로 전체 실행 그래프를 완주시키지는 않았다.
- native MCP 추가·조회·제거를 실제 실행했으나 plugin 설치·업데이트의 모든 조합은 실제 실행하지 않았다.
- R13 전체 결과·취소·검토·통합 31개 검사는 실제 저장소·host·DB를 사용하되 provider adapter는 테스트 대역이다.
  결과 본문이 한도를 넘으면 명시적으로 차단하며 원본은 보존한다. 자동 잘림·권한 상승은 하지 않는다.
- 성능 벤치마크, commit/push, 사용자 설치판 교체와 공개 배포는 수행하지 않았다. 기존 미커밋 작업은 보존했다.

완료 시점 소스 1,232개 파일의 hash는 `review-complete-inputs.json`, 구조화된 판정은
`implementation-acceptance.json`에 기록했다. 최종 전체 검사 시작 후 바뀐 소스는 위에서 재검사한
`test/mobile-webview74-verifier.test.ts` 한 파일뿐이다. 검수용 emulator·Storybook·원격 host는 종료했다.
