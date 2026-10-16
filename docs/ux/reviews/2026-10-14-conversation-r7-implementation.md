# 대화 작업 공간 R7.1 구현 기록

상태: 승인 범위 구현 및 로컬 검수 완료. 공개 배포나 물리 기기 업그레이드 인증을 뜻하지 않는다.

## 승인 기준

- 사용자 승인 R7.1, 원본 source commit `0c92be2063a53648fc0f17b4fa791a0ccb96c65e`.
- 승인 시안: <https://ezterminal-conversation-r6.brawnycake257.chatgpt.site>.
- 말풍선·CLI와 Dark·Light·High Contrast·Matrix·사용자 지정 테마를 모두 적용한다.
- 한 작업 공간에서 서로 다른 프로젝트의 세션을 함께 배치한다. 생성과 실행 경로는 각 프로젝트에 속한다.
- 기존 작업 트리의 변경을 보존한다. 고정 handoff와 시안 원본은 수정하지 않는다.

## 구현 체크리스트

- [x] 공용 토큰, 두 스킨, 네 테마 및 custom 호환
- [x] 간결한 대화 헤더, composer 설정, 턴별 실행 기록, 검토 연결
- [x] 프로젝트별 새 대화·새 터미널 나란히 제공
- [x] 실제 daemon 대기열 조회·회수·삭제·선택 실행 및 경쟁 상태 보호
- [x] 독립 작업 공간 탭, 저장·복원, 분할·집중·별도 창 수명 유지
- [x] Android 연결, 입력·Back·오프라인 호환
- [x] 직접 캡처, 관련 검사, 일반 E2E
- [x] Windows·Android 검수 빌드와 소스 식별자

## 실제 동작

프로젝트 행과 프로젝트 작업 화면에서 새 대화·새 터미널을 나란히 연다. 대화 생성과
터미널 실행은 선택한 프로젝트의 위치를 사용한다. 상단 UI 작업 공간에는 다른 프로젝트의
패널도 함께 배치할 수 있다. 작업 공간 이름 변경·이동·닫기, 가로·세로·1+2 분할과
집중 보기를 제공하고 기존 드래그·별도 창·복귀 동작을 유지한다. 전환은 같은 Dockview의
그룹을 숨기는 동작이며 패널이나 실행 세션을 다시 만들지 않는다. 공간 닫기는 패널을
남은 공간으로 옮긴다. 저장된 레이아웃에는 작업 공간 소속과 활성 패널도 포함된다.

입력창에는 모델·권한 설정을 모으고, 연속된 도구·추론 기록은 접을 수 있는 실행 기록으로
표시한다. 승인·오류는 별도로 남는다. 최신 메시지로 이동, 첨부·답장·초안 복원과
스킨 전환은 공용 대화 상태를 사용한다. 패널 크기를 기준으로 입력과 검토 영역을 배치한다.

대기열은 호스트가 수락한 queued 턴에서 읽는다. 회수·삭제·중단 후 실행은 호스트에서
턴 revision과 소속·쓰기 권한을 검사한다. 회수 성공 응답 후 입력창에 넣으며, 기존 초안의
첨부·커서 위치까지 보관했다가 전송 후 복원한다. 명령 응답 유실을 성공으로 추정하지 않는다.
구 호스트에 `agent-queue` capability가 없으면 수정 조작을 제공하지 않는다.

변경 검토는 현재 세션의 완료된 비민감 도구 결과만 사용한다. Codex가 완료하지 않은
패치와 다른 세션의 기록은 제외한다. Claude Edit/Write 부분 기록에는 전체 diff나 파일
줄 번호를 만들어 붙이지 않는다. 최근 변경 턴·대화 전체, 기록별 확인 표시, 줄 범위 인용을
제공하며 인용은 기존 초안에만 들어간다. 현재 작업 트리와 보고된 패치의 차이를 표시하고,
데스크톱에서는 현재 프로젝트 파일로 별도 진입한다.

Android 검토창은 기존 `MobileActionSheet`와 탐색 이력을 사용한다. 실제 Back이 시트만
닫고 대화·초안을 유지하도록 연결했다. WebView 74에서 선택 상자의 화살표·안쪽 여백과
시트의 위치·높이·여백이 유지되도록 호환 스타일을 보완했다.

## 검증

로그 기본 경로는 `artifacts/conversation-r7/`다. 아래 개수는 서로 겹치는 재검사를 합산하지 않았다.

| 검사 | 관측 결과 | 근거 파일 |
| --- | --- | --- |
| 전체 단위 검사 | 3,486 통과, 기존 5 skip | `unit-tests-final.log` |
| 최종 제공자·변경 기록 회귀 검사 | 103 통과 | `provider-tests-final.log` |
| 모바일 시트 연결 후 공용 대화 검사 | 25 통과 | `review-desktop-tests.log` |
| 모바일 전체 단위 검사 | 61개 파일, 608 통과 | `mobile-tests.log` |
| OS 검사 | 38 통과 | `os-tests.log` |
| Storybook | 대화·작업 공간 27, 폼 5 통과; 시트 연결 후 대화 23 재검사 통과 | `storybook-tests.log`, `forms-storybook.log`, `review-storybook-tests.log` |
| 타입·린트 | root와 mobile 통과 | `typecheck.log`, `lint.log`, `review-lint.log`, `mobile-lint.log` |
| 프로젝트 맵·가드 | 맵 7개, design/handoff/approval/pairing/Claude 가드 통과 | `project-map-check.log`, 관련 guard 로그 |
| 일반 전체 E2E | 146개 중 145 통과, 프로젝트 터미널 연속 생성 1 실패 | `e2e.log` |
| 관련 E2E 재검사 | 33 통과, 터미널 해당 시나리오 3회 연속 통과, 작업 공간 최종 1 통과 | `e2e-final-focused.log`, `e2e-terminal-repeat.log`, `e2e-workspace-final.log` |
| 최종 Windows EXE 전체 검사 | 8 통과 | `packaged-tests.log`, `packaged-tests.result.json` |
| Android 네이티브 검사 | API 29, 아래 시나리오 모두 통과, 프로세스 종료 코드 0 | `android/run/result.json`, `android-journey.result.json` |

일반 E2E 최초 실패는 두 번째 프로젝트 터미널 탭이 기대 개수에 도달하지 않은 경우였다.
단독 재실행과 관련 검사 묶음, 추가 3회 반복에서 통과했다. 최종 전체 146개를 다시 실행한
것으로 표시하지 않는다. 이후 모바일 시트 연결과 구형 WebView 스타일은 모바일 전체 검사,
공용 대화 검사, Storybook 및 실제 네이티브·패키지 검사로 확인했다.

Windows 패키지 전체 검사에서는 과거 CLI 대화 검사 시작 시 CDP renderer 페이지를 찾지
못한 일이 두 번 있었다. 해당 시나리오 단독 3회와 두 탐색 검사 연속 실행이 통과했다.
시작 로그를 수집하는 진단 전체 실행 8개, 진단 변경을 제거한 원래 전체 실행 8개도 통과했다.
이 일시적 시작 실패의 원인은 확정하지 않았다. 최초 로그는 `packaged-tests-first.log`,
`packaged-tests-second.log`, 재검사 로그는 `packaged-history-repeat.log`,
`packaged-debug.log`, `packaged-diagnostic-full.log`에 보존했다.

Android에서는 실제 Windows 호스트·원격 연결과 결정적 Codex fixture를 사용했다.
이전 CLI 기록 열기가 제공자를 시작하지 않음, Enter 줄바꿈, 강제 종료 후 암호화 초안 복원,
첫 전송이 세션·턴 하나만 생성함, Back으로 검토 시트만 닫힘, 연결 단절 시 전송 비활성화,
재연결 시 초안 유지·자동 재전송 없음, 선택 상자·시트가 화면 범위 안에 있음을 확인했다.
네이티브 탐색·키 입력과 controlled WebView 텍스트 입력을 사용했으며 물리 IME 검사는 아니다.

## 캡처

`artifacts/conversation-r7/after/`에는 실제 production Storybook 컴포넌트의
4개 테마 × 2개 스킨 8개 캡처가 있다. `responsive/`에는 320×640, 390×844,
600×400, 1440×1000과 4개 테마의 16개 조합별 대화·검토 캡처가 있다.
관측한 Axe 위반과 JavaScript 오류는 0개이며 입력창 가림·가로 넘침이 없고 줄 인용이 동작했다.
Storybook 메시지는 시각 검사용 fixture이며 실제 제공자 응답으로 제시하지 않는다.

`electron-split-workspace.png`는 실제 Electron 분할 화면이다. 작업 공간 왕복 전후의
패널 동일성과 240px 분할 높이 보존을 확인했다. `android/run/01-previous-conversation.png`부터
`07-reconnected-draft.png`까지는 실제 Android WebView 캡처이며, `05-native-review-sheet.png`는
최종 네이티브 검토 시트다. 고정 handoff·원본 시안·기존 golden snapshot은 변경하지 않았다.

## 설치 후보와 소스

목적지: `artifacts/r7-release-2026-10-14/`.

| 파일 | SHA-256 |
| --- | --- |
| `EZTerminal-Setup-2.0.0-r7.exe` | `90087b73eeefed8075c6db0eb5911150862980ff81b90d1ee0e9c1c5fc9dfca0` |
| `EZTerminal-Android-2.0.0-vc77-r7.apk` | `d55cbb5b5d9bb41842332ac094a6c8cb163d839fdd4bcd583bb89bfe94dfd2f9` |

- 빌드 식별자: `r7-local-263ef4f3c8106e72`.
- 전체 입력 SHA-256: `263ef4f3c8106e726b8572290ac6d41651b0ba5821bdc3d8ef3f4659613239f1`.
- 기반 Git HEAD: `a25e3ee3bb2800aaf4d3c139c81312a44f7ea413`. 빌드 식별자는 Git 커밋이 아니다.
- 기존 미커밋 변경을 포함한 2,806개 파일을 해시했고, `source-after-validation.json`에서
  빌드부터 검사 완료까지 입력 변경 0개를 확인했다. 이 결과 문서의 후속 수정은 따로 기록한다.
- Windows 앱·호스트·제거 프로그램·설치 파일의 버전과 미서명 상태를 검증했다.
  이전 설치 파일의 해시는 보존됐고 사용자 프로필에 설치 프로그램을 실행하지 않았다.
- Android production 자산 23개, E2E 마커 부재, 서명 인증서, versionCode 77을 확인했다.
  최종 서명 APK를 소유한 read-only API 29 에뮬레이터에 설치하고 설치된 APK 해시까지 대조했다.
  non-debuggable 상태, 실행 유지, foreground, 오류 없는 앱 로그와 첫 화면을 확인했다.
  네이티브 조작 검사는 같은 production 웹 자산을 담은 debug wrapper에서 수행했다.

물리 기기의 IME, 기존 설치판 업그레이드, 유료 실제 제공자 실행, 공개 배포는 수행하지 않았다.
성능 벤치마크도 요청되지 않아 실행하지 않았다. 파일별 해시·검사 범위·초기 실패 이력은
산출물의 `release-manifest.json`, `SHA256SUMS.txt` 및 플랫폼별 보고서가 소유한다.
