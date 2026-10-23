# EZTerminal 2.0 구현·검증 기록

기준: [r6 승인 기록](ux/reference/v2/APPROVAL.md), [제작 로드맵](ux/reference/v2/ROADMAP.md),
[W01–W09 인계](ux/reference/v2/HANDOFF.md). 2026-10-13 사용자가 기준 정리와 나머지 단계 전체 진행을 지시했다.
이 파일은 작업 진행과 근거를 기록하며 제품 안에 별도 로드맵 기능을 만들지 않는다.

2026-10-14 후속 r5: 첫 입력 자동완성·프로젝트 트리·통합 대화 기록의 누락을 보완했고
로컬 통합 검수와 별도 r5 Windows/Android 설치파일 생성을 완료했다.
아래 과거 완료 수치는 이 기능들의 완료 근거가 아니다. 현재 변경과 실제 제공자 재개,
Desktop/Android 시안 및 패키지 검수 결과는 [r5 검토 기록](ux/reviews/2026-10-14-agent-experience-r5.md)을 따른다.

G1–G7 구현과 G8의 로컬 자동 검증·개발 후보 패키징을 완료했다. Windows/Android 2.0.0
산출물은 `artifacts/v2-candidate/`에 있다. 물리 기기의 IME·기존 설치판 업데이트 검증은
미실행이므로 공개 출시 준비 완료로 표시하지 않는다.

## 설계 기준과 소유권

- P6/P7: 사용자 전체 진행 지시로 승인. 설계 승인만으로 개별 화면 클릭 검토나 제품 구현·검증까지 완료됐다고 인정하지 않는다.
- UI `design_context`: `required: true`, `DESIGN.md`, `docs/ux/frontend-design.md`.
- Windows 구현 경로: `src/renderer/`; Android: `mobile/src/`. 실제 값은 기존 theme/token source가 소유한다.
- 신규 Dark·말풍선, 기기별 CLI 스킨은 같은 채팅의 표현. 기존 설정·실제 터미널·외부 도구 수명은 보존한다.
- 기존 미커밋 사용자 변경을 보존한다. 고정 `desktop-handoff` 원본과 기준 이미지는 변경하지 않는다.
- 멀티에이전트는 대표 담당과 최대 3개 작업자 슬롯을 사용하고 공유 계약의 소유자를 한 명으로 둔다.

## 단계와 수용 기준

아래 상태는 최종 로컬 검증 결과다. 설계 승인과 제품 검증, 출시 준비 완료를 구분한다.

| 단계 | 담당 | 수용 기준 | 구현·검증 상태 |
| --- | --- | --- | --- |
| G1 | W01 | 공통 모델·revision·명령 중복 방지·저장·이전·확정본·AI 프로필 snapshot; Windows/Android 의미 동등 | 기획 저장·인증 IPC/WS·실행 원장·schema 이전 구현과 단위·호스트 검사 통과. Android 실제 저장/복구 흐름 통과 |
| G2 | W02/W03 | 한 칸 탐색·두 채팅 스킨·플랫폼별 입력, 전환 시 세션·초안·첨부·승인·대기열 보존 | 공통 스킨·실제 첨부/답장·암호화 초안/전송 복구 구현. 탐색·포커스·세션 보존·재연결 회귀 검사 통과 |
| G3 | W04 | PRD→기능→흐름→화면 연결, 버전·충돌·되돌리기·변경 영향·무관 작업 유지 | 항목·IA·흐름·링크·작업·프로필 편집과 freeze/branch/undo 구현. AI 제안 생성·명시 적용·암호화 복구·프로필 상속과 참조 연결 검사 통과 |
| G4 | W05 | scene·공통 요소·예외·반응형·상태·자산 왕복, 고정본 보존 | scene 편집·연결 요소·예외·체험과 이미지/폰트 binary 왕복 구현. 실제 브라우저·접근성·파일 무결성 검사 통과 |
| G5 | W06 | 역할별 설정·허용된 실행·분업/후보/독립 검토·의존성·중단/재개·장애 대체·추가 복구 2회 | 실제 daemon/provider 연결, frozen 설정·재시작·재시도·영향 중지·환경 격리·명시 대체 구현 및 집중 검사 통과 |
| G6 | W07 | exact revision 검토·diff·안전 저장·검증 근거·로컬 통합·실패 보존 | 실제 Git 작업 사본·검증·독립 검토·로컬 통합·partial 보존 구현. 사용자 기기 증빙 등록·독립 재검토·통합 후보 재개와 원자적 캡처 저장 검사 통과 |
| G7 | W08 | 실제 터미널·SSH·파일·PC 제어·OpenClaw·자동화 유지, 인증 제외 전체 백업·수동 정리 | 백업·복원·기록 열람·보호된 기록 정리와 Android 파일 이동 구현 및 검사 통과. 기존 기능을 포함한 일반 Electron E2E 141개 통과 |
| G8 | W09 | 이전·재시작·Android 오프라인/재연결·불명확 요청 대조·기능/접근성/시각 검증·패키지 | 로컬 검증·개발 후보 패키징 완료: 타입·린트·Android 575개·OS 38개·Electron 141개·패키지 5개 및 API29/API35 기능 검사 통과. 물리 기기·기존 설치판 업데이트 검증은 미실행 |

## 검증 원칙

관련 단위·호스트 통합·typecheck를 수행하고 UI 상태를 Storybook과 시각 근거로 확인한다.
일반 제품 회귀는 `pnpm e2e`다. Android 실기기·릴리스 패키지 검증을 시안 Playwright 결과로
대신하지 않는다. 성능 벤치마크는 명시적 별도 요청이 없으므로 실행하지 않는다.

reference r6 QA는 이전 시안 검증 증거다. 승인 메타데이터와 검토 포털 문구 정리로 source 해시가
달라졌으므로 재실행 전에는 최신 승인 포털의 전체 QA 통과로 해석하지 않는다. 제품 검증과 구분한다.

## 기준 정리 기록

2026-10-13: 승인 영속 원본·파일 해시 manifest, 재생성 시 기록 보존, 과거 revision 구분,
활성 시각/UX 계약 승격을 진행했다. 문서 정리의 상세 검증은 [승인 검증 기록](ux/reference/v2/APPROVAL-VALIDATION.md)을 따른다.

## 구현 검증 기록

- 공통 기획 저장: legacy 빈 읽기, 동시 revision, 중복 명령 재시작, 확정본 불변, 참조/의존성, 외부 변경·손상·junction, 프로필 명시 적용 및 공통 요소 예외 보존 검사 16개 통과.
- 기획 권위/원격 연결: 인증 주체 강제, shutdown admission, v13 기획 요청과 v12 기존 연결 호환을 포함한 3개 파일 180개 검사 통과. Android transport 관련 9개 검사 통과.
- 대화 입력: 텍스트·이미지 첨부를 실제 Codex/Claude 입력으로 전달하고 SQLite schema 6에 기록. 답장 원문은 같은 세션의 비민감 메시지와 대조한다. 첨부는 최대 4개, 각 480 KiB, 전체 context 700 KiB이며 UI와 host가 함께 검증한다.
- 첨부·provider·daemon·원장·실행 준비 관련 묶음은 5개 파일 165개 검사 통과. 실행 준비만으로 미실행, 전송 전 attempt 기록, start 중복 방지, 재시작 중복 호출 방지를 확인했다. G5 상태는 이 검사와 이후 실행·결과 서비스 검사를 함께 따른다.
- 공통 채팅 production Storybook: PC 1440/800 및 Android 390/360 폭에서 overflow/입력 위치 확인, axe 위반 0. 증거는 `artifacts/v2-g2-chat/report.json`과 캡처 6개다. 고정 handoff 원본은 변경하지 않았다.
- Windows 채팅 암호화 저장/IPC 17개, 복구 controller 9개, 실제 DockPanel 연결 6개 검사 통과. Android 보안 초안·첨부·답장·selection·동일 명령 복구 검사 8개 통과.
- Android 물리 기기는 연결되지 않았다. 별도 임시 API29/API35 에뮬레이터에서 네이티브 설치·WebView 검증을 수행하며, 실제 휴대전화의 IME·제조사별 동작 검증은 미실행으로 남긴다.
- 첫 `pnpm test`에서 발견한 project-map 근거 범위·해시는 실제 소스 의미를 검토해 갱신했다. 기존 5개 지도와 신규 기획·실행 지도 검사가 통과했다. 전체 단위 재검사는 357개 파일·3,286개 통과, 1개 파일·5개 검사를 기존 조건에 따라 건너뛰었다(`artifacts/v2-unit-suite-final.log`). 마지막 기기 증거 경로 변경까지 포함한 종합 게이트는 후속 실행 결과로 구분한다.
- 최신 전체 타입 검사 통과. 린트 오류 0개(기존 테스트 중복 import 경고 2개). 생성된 `artifacts/` 진단 출력은 제품 소스 린트에서 제외한다.
- Android 전체 단위 57개 파일·574개 검사 통과. Windows OS 통합 5개 파일·38개 검사 통과. 근거: `artifacts/v2-mobile-tests.log`, `artifacts/v2-os-tests.log`.
- approval-privacy, pairing-offline, design-style, desktop-handoff, Claude provider guard 통과. 2.0.0 / Android versionCode 76 / remote v13 버전 계약 통과. 기존 v12 연결은 새 기획 기능을 명시 거절하고 호환되는 기존 기능을 유지한다.
- 실제 이미지 naturalWidth·FontFace loaded를 포함해 AI 변경안·기록·시안 production story의 Windows 1440 / Android 390 폭에서 가로 넘침 0·JS 오류 0·axe 위반 0을 확인했다.
- 추가 검토 세션의 세대 ID도 실행 권위의 종료 게이트를 따르도록 수정했다. 종료 후 실행 허용을 재현한 검사에서 실패를 확인하고 수정 후 실행 서비스 3개 검사가 통과했다(`artifacts/v2-reviewer-gate-red.log`, `artifacts/v2-reviewer-gate-green.log`).
- 마지막 기기 증빙 구현을 포함한 종합 단위 검사에서는 3,294개가 통과하고 Git 작업 사본 검사 5개가 동시 빌드 부하 중 timeout/파일 잠금으로 실패했다. 해당 2개 파일을 단독 재검사해 22개 모두 통과했다(`artifacts/v2-validation-gate.log`, `artifacts/v2-git-regression-verified.log`). 원래 종합 명령이 한 번에 성공했다고 해석하지 않는다. 후속 OS 검사 38개도 통과했다(`artifacts/v2-os-final.log`).
- API29의 WebView74에서 원본 Android smoke와 강제종료 복구 검사가 통과했다. 최초 간헐 탭 실패 후 임시 관측 코드를 제거하고 원본 검사로 재확인했으며 제품 수정으로 해결했다고 주장하지 않는다. PC PTY 유지와 복구 후 입력, native xterm 터치까지 확인했다(`artifacts/g8-android/api29-smoke-original.log`, `artifacts/g8-android/api29-restart-original.log`).
- Android 실제 기획 흐름에서 재연결 직후 기획 탭이 초기화되는 문제를 재현했다. 인증 후 임시 loading/null snapshot에 캐시된 프로젝트가 사라지던 경계만 수정했으며 실제 빈 프로젝트 응답은 계속 반영한다. 단위 red→green 및 관련 25개 검사 통과. 같은 API29/WebView74 시나리오에서 작성→PC revision 1, 오프라인 편집·저장 차단, 강제종료 후 암호화 초안 복구, 재연결 전후 표시 중인 기획 탭 유지, 자동 전송 없음, 명시적 저장→revision 2·이력 2개·AI 실행 0개까지 통과했다. 기획 조작은 WebView DOM 입력/클릭이며 네이티브 IME 검증은 아니다(`artifacts/g8-android/planning-workflow-report.json`).
- API35에서도 수정된 APK의 원본 smoke와 강제종료 복구 검사가 통과했다. 실제 명령 출력·xterm 네이티브 터치·PC의 기존 PTY replay·복원 후 입력을 검증했다(`artifacts/g8-android/api35-smoke-original.log`, `artifacts/g8-android/api35-restart-original.log`).
- 재연결 수정 후 Android 전체 단위 검사를 다시 수행해 57개 파일·575개 검사가 통과했다(`artifacts/g8-android/mobile-unit-final.log`).
- Android 최종 production 웹 자산 빌드·WebView74·E2E 표시 제거·APK 생성 검사를 통과했다. 산출 APK를 API35에 직접 설치해 native identity 1개, 실제 시작 화면의 Connect/v2.0.0, JavaScript 오류 0·가로 넘침 0을 확인했다. 전체 터미널 기능 검사는 같은 소스의 E2E APK로 수행했으며 최종 APK의 별도 설치/시작 검증과 구분한다. 검증용 에뮬레이터는 모두 종료했다(`artifacts/g8-android/android-verification.json`).
- 열린 패널 뒤에 Tools 메뉴가 가려지는 Electron 실패를 실제 브라우저에서 줄여 재현했다. 메뉴가 열려 있을 때만 기존 dropdown 계층을 적용한 뒤 1024/1440 폭의 pointer·키보드 검사 2개와 관련 단위 19개가 통과했다. 고정 handoff 원본은 변경하지 않았다. 최종 Windows 패키지에 반영하고 원래 실패한 Electron 시나리오도 모두 재검증했다.
- 최종 일반 Electron 전체 검사 `pnpm e2e --output=artifacts/v2-e2e-final-results`가 141개 모두 통과했다(18.6분, 자동 retry 0). 기획 저장·재시작, 기존 PTY/TUI·한글 조합 입력·SSH·파일·OpenClaw, 창 분리·레이아웃·프로젝트 작업 사본·agent child·테마와 Tools 회귀를 포함한다(`artifacts/v2-e2e-final.log`). 성능 벤치마크와 soak 검사는 포함하지 않았다.
- 최종 `pnpm test:e2e:packaged`는 5개 모두 통과했다. 실제 패키지 EXE에서 app.asar 내부 interpreter, 실제 Windows 포인터로 창 분리, native PTY, localhost SSH 왕복, OS clipboard를 검증했다(`artifacts/v2-packaged-e2e.log`). 검증 전후 설치 파일·EXE·app.asar·native host 해시가 산출물 manifest와 일치했다.

## 로컬 산출물과 남은 출시 확인

| 산출물 | 위치 | 검증 경계 |
| --- | --- | --- |
| Windows 설치 파일 | `artifacts/v2-candidate/EZTerminal-Setup.exe` | 서명하지 않은 2.0.0 개발 후보. 포함된 패키지 EXE 5개 검사 통과; 후속 설치 실행 상태는 아래 세션 인계를 참조 |
| Android APK | `artifacts/v2-candidate/EZTerminal-Android-2.0.0-vc76-development.apk` | E2E 표시 없는 production 웹 자산·개발 인증서. API35 설치·식별·시작 화면 통과 |
| 소스·산출물 증빙 | `artifacts/v2-candidate/windows-artifacts.json`, `android-artifacts.json` | 수정된 작업 트리 입력 1,154개와 SHA-256 기록. clean release SHA 인증이 아님 |

최종 공통 소스 fingerprint는 `2f92e435ebad49908e77207cbd85ea860941c6b8973bf95ffe5d02c3e54d4bd4`다.
Windows 빌드 이후 Android의 재연결 수정 파일 2개만 달라졌고 Windows 입력은 동일함을
`windows-source-comparison.json`으로 확인했다. 빌드·검증 종료 후에도 최종 소스 fingerprint가 유지됐다.

연결된 물리 Android 기기가 없어 네이티브 IME·제조사별 동작을 확인하지 못했다. 사용 중인
Windows 설치판과 실제 사용자 데이터를 사용하는 업데이트 수용 검사는 수행하지 않았다. Git commit/push,
공개 배포, 성능 측정·soak 검사는 이번 작업에 포함하지 않았다. 이 조건이 남아 있는 동안
G8의 공개 출시 준비 완료 상태는 보류한다.

## 현재 구현 경계

- AI 기획 제안은 제공자가 도구 실행을 확실히 차단할 수 있는 Claude SDK 경로를 사용한다. 현재 Codex app-server는 동등한 차단 계약을 제공하지 않아 해당 생성만 명시적으로 미지원 표시한다. 일반 Codex 대화와 승인된 실행은 유지한다.
- 시안 binary 자산은 PNG/JPEG/WebP/GIF/WOFF/WOFF2, 파일당 512 KiB다. 원본 해시가 달라지면 읽기를 거절한다. 시안 파일에는 사용하는 자산 bytes를 함께 담고 누락 파일을 성공한 이동으로 표시하지 않는다.
- 프로젝트 백업은 최대 50 MiB의 검증된 기록 패키지다. 한도 초과 시 부분 성공 대신 실패하며 원본을 보존한다. 인증·실행 중 프로세스·실행 권한은 복원하지 않는다. 소스 저장소 전체는 외부 참조이며, 결과 patch/base blob과 제외 항목을 manifest로 확인한다.
- 기기 검증 증빙은 사용자가 실행·확인했다고 명시한 기록이다. 정확한 attempt·artifact 또는 통합 candidate commit에 연결하며 호스트가 대신 실기기 검사를 수행했다고 표시하지 않는다. 로그·캡처는 각 512 KiB, 요청 전체는 700 KiB까지 보존한다.
- 병렬 실행은 포트·임시 폴더·출력·테스트 namespace를 구분한다. 공용 환경을 쓰는 작업은 순차 실행한다. namespace를 사용하는 테스트 도구의 계약을 지켜야 하며 충돌 시 다른 프로세스를 종료하지 않는다.
- 앱/설치 파일의 버전은 개발 후보 2.0.0이다. 작업 트리에 기존 사용자 변경이 함께 있으므로 clean release SHA·공개 배포·실기기 검증 완료로 해석하지 않는다.

## 다음 세션 인계 · 2026-10-13

### 재개할 작업

사용자는 이번 세션을 마치고 다음 세션에서 현재까지의 구현을 개선하기로 했다.
새로 기획을 시작하거나 승인된 r6 설계를 폐기하는 요청은 아니다. 개선 우선순위는 다음
세션의 사용자 피드백을 먼저 따른다. 이 인계 기록 자체가 새 기능 추가 승인은 아니다.

먼저 이 문서와 [설계·화면 포털](ux/reference/v2/index.html)을 읽고 실제 설치판의 사용 흐름을
확인한다. UI 변경 시 `AGENTS.md`가 정한 DESIGN → UX 계약 → production story → component
순서를 지킨다. 제작 로드맵을 별도 제품 기능으로 추가하지 않는다.

### 마지막으로 확인한 일반 세션 동작

- Orca는 에이전트 하나를 선택한 일반 세션과 일반 터미널을 제공한다. 비교 근거는
  [Orca 세션 문서](https://www.onorca.dev/docs/model/agents-sessions)와
  [터미널 문서](https://www.onorca.dev/docs/terminal)다.
- EZTerminal의 프로젝트 **새 대화**와 상단 AI 시작은 일반 세션 초안을 연다. 기획 문서나
  확정본을 먼저 만들 필요가 없으며, 프로젝트·작업공간과 제공자·모델을 선택한다.
  진입은 `src/renderer/App.tsx`의 `openStructuredAgentDraft` 및 `planningNavigation`,
  선택 조건은 `NewSessionDraftPanel.tsx`에서 확인한다.
- 일반 AI 대화에도 말풍선/CLI 스킨이 적용된다. 상단 **새 터미널**은 실제 터미널을 바로 연다.
  기획 기반 멀티에이전트 실행은 프로젝트 **작업 → 실행 준비 → 시작**의 별도 경로다.
- 프로젝트·작업공간에 연결하지 않는 독립형 AI 대화는 현재 없다. 사용자는 일반 세션 지원
  여부를 질문했으며, 독립형 세션을 추가하거나 기본 진입 화면을 바꾸기로 확정하지 않았다.
  필요하면 다음 세션에서 이 사용성부터 검토한다.

### 설치·검증 상태

- 사용자 요청으로 `artifacts/v2-candidate/EZTerminal-Setup.exe`를 실행했다.
  세션 종료 시 `C:\Program Files\EZTerminal\EZTerminal.exe`의 ProductVersion 2.0.0을
  읽기 전용으로 확인했다. 설치 마법사의 완료 과정이나 기존 데이터 업데이트 수용 검사를
  수행했다고 주장하지 않는다. 사용자 피드백으로 실제 첫 실행 상태를 확인한다.
- 검증 수치와 로그는 위 기록 및 `artifacts/v2-candidate/verification-summary.json`을 따른다.
  최종 일반 E2E 141개와 패키지 5개는 모두 통과했다. 최초 종합 단위 명령의 실패와
  분리 재검사 결과를 하나의 무실패 실행으로 합쳐 표현하지 않는다.
- 종료 시 `source-inputs-session-close.json`으로 빌드 입력 1,154개의 fingerprint가 위 최종
  값과 동일함을 확인했다. 향후 수정 후에는 이 검증 결과를 새 소스의 결과로 간주하지 않는다.
- 물리 Android IME·제조사별 동작과 실제 기존 설치판 업데이트는 아직 수용 검사가 필요하다.
  Android native 터치의 최초 간헐 실패는 원인 미확정이고 원본 재검사는 통과했다.
  재현 없이 추가 지연이나 임의 재시도를 넣어 해결했다고 표시하지 않는다.

### 작업 트리 보존

- 기준 HEAD는 `a25e3ee3bb2800aaf4d3c139c81312a44f7ea413`이다. 커밋·push·공개 발행은 하지 않았다.
  작업 트리에 이번 구현과 기존 사용자 변경, 미추적 신규 파일이 함께 있다. 먼저 git 상태를
  읽고 기존 변경을 보존하며 reset/일괄 정리하지 않는다.
- 기존 OpenClaw 관련 변경과 `.ezterminal/project-map/` 자료, 고정 desktop handoff 원본을
  보존한다. `.ezterminal/mobile-v2-projects.png` 등 작업 공간에 남은 사용자 자료도 지우지 않는다.
- 테스트용 Storybook과 API29/API35 에뮬레이터는 종료했다. 사용자 앱·설치된 remote-host
  서비스·OpenClaw를 세션 정리를 이유로 종료하지 않는다.
- 일반 회귀는 `pnpm e2e`다. 성능 벤치마크는 사용자의 명시적 성능 측정 요청 없이는 실행하지 않는다.

## 후속 개선 계획 검토 · 2026-10-13

첫 메시지 전 스킬·확장 탐색, 단계별 대화 연결과 기획 추가 진입에 대한 사용자 피드백을 반영한
[대화·기획 연결 개선 계획](ux/agent-workflow-plan.md)을 작성했다. 30개 시나리오에서 시작·전환·
복귀·재작업·원격 복구를 점검하고, 일반 대화 개선을 우선 진행한 뒤 여러 기획의 저장·이전과
기존 실행/검토 연결을 확장하는 순서로 정리했다.

이 기록은 계획 수정이며 새 기능 구현 완료 기록이 아니다. r1/r2는 검토 시안으로 유지하고,
다음 시안의 디자인 확정 후 제품 UI에 반영한다. 위 G1–G8 결과와 기존 산출물 검증은 해당 시점의
기록으로 보존하며, 이번 계획의 제품 검증 결과로 재사용하지 않는다.

## 후속 계획·시안 수정 · 소프로젝트와 일반 대화 r4

사용자 요청으로 [개선 계획](ux/agent-workflow-plan.md)을 소프로젝트 기준으로 수정하고
[r4 시안](ux/reference/v2-agent-chat-r4/index.html)을 추가했다. 소프로젝트는 이전 논의의 기획과
같은 단위다. 프로젝트 바로 아래 일반 대화를 같은 깊이로 표시하며 소프로젝트 없이 대화할 수 있다.
프리셋/대화 생성, 그래프·목록 편집, 단계별 여러 대화, AI의 초안 직접 수정과 되돌리기,
시작 당시 버전을 보존하는 실행 모형을 검토할 수 있다.

계획은 기존 30개와 추가 16개 시나리오, 그래프/AI 앱 스킬의 저장·권한·검증·실행 경계를 포함한다.
시안 작성 당시에는 실제 그래프 엔진·스킬 설치·provider 도구·영구 저장의 제품 구현 전이었다. 시안의 검증 결과와 한계는
[r4 검토 기록](ux/reference/v2-agent-chat-r4/VISUAL-REVIEW.md)에 둔다. r1–r3 및 승인된 r6는 보존하며,
G1–G8의 제품 검증 결과를 이번 시안의 제품 검증으로 재사용하지 않는다.

## r4 승인 이후 구현·검수 · 2026-10-13

사용자가 r4를 승인하고 **각 구현은 멀티에이전트, 이 세션은 검수**로 진행하도록 지시했다.
[승인 기록](ux/reviews/2026-10-13-agent-workflow-r4-approval.md)에 당시 원본 해시를 보존했다.
첫 대화 전 기능 탐색·확장 관리, 소프로젝트·실행 도메인, Desktop·Android UI를 나누어 구현하고
root에서 통합 검수를 완료했다. [최신 검수 기록](ux/reviews/2026-10-13-agent-workflow-r4-implementation.md)에
발견한 문제·수정·재검사와 실제 환경의 검증 한계를 기록한다.

검수 시작 시점의 작업 트리 1,156개 파일을 `artifacts/r4-implementation-review/baseline/`에 복사하고
`baseline-inputs.json`에 SHA-256을 기록했다. 기존 미커밋 변경과 이번 구현을 구분하는 기준이며,
제품 검증 통과 기록은 아니다. 최종 검수는 새 일반 대화의 0턴 탐색, 실제 Codex·Claude의 앱 도구 호출,
소프로젝트·단계 대화·실행 결과 전달, 일반 E2E와 API 29 APK 복구를 포함한다. 기존 시안·승인 자료
528개 파일의 SHA-256이 일치했다. 물리 기기 IME와 native plugin 관리의 모든 조합은 미검증이며,
성능 벤치마크·설치판 업데이트·공개 배포를 수행한 것으로 취급하지 않는다.

## Orca급 채팅·테마·UI 개편 · 2026-10-15~16

사용자가 2.0 채팅 사용경험을 Orca 수준으로, 이어서 테마와 나머지 UI/UX를 같은 품질로 개편하도록
지시했다. 브랜치 `feat/v2-ux-overhaul`(체크포인트 `6810073`)에서 단계마다 제품 컴포넌트 Storybook →
어드바이저 → 사용자 승인 → 격리 프로필의 실제 Electron·실제 세션 육안 확인 → 커밋 순서로 진행했다.

- **테마**: 기본 Dark/Light는 Ink, Matrix는 Matrix Refined로 확정했다. 파생 색은 테마별로 미리 계산한다.
  사용자 테마가 `ui`만 제공해도 기존 터미널 크롬(`--term-*`)이 그 팔레트를 따른다.
- **채팅 데이터**: 대화 항목 payload, 승인 요청·응답, 추론 강도를 선택 필드와 capability로 추가했다.
  원격 v16·daemon v12 프로토콜은 올리지 않았다. 저장소는 v7(단방향)이다.
- **화면**: 말풍선·CLI 두 스킨, 셸 압축과 사이드바 상태, 기획·워크플로 단일 헤더를 개편했다.
  설정·탐색기·Monitor·원격·OpenClaw는 토큰과 공통 컴포넌트로 정리했다.
- **Android(WebView 74.0.3729.185, API 29)**: 다음을 확인했다.
  - 대화 여정과 테마·이펙트 시나리오
  - 신 호스트·구 APK와 구 호스트·신 APK 양방향 대화
  - Terminal 탭을 가리던 빈 페이지 셸(기준선 결함) 수정
  - 모바일로 가는 `color-mix()`마다 Chrome 74 대체 선언 추가

남은 확인과 경계:
- `mobile/e2e/planning-workflow.ts`는 사용자 결정에 따라 2.0 흐름(첫 전송이 대화를 만든다)으로 다시 썼다.
  고정 응답 fixture만 한 턴에 답하고 실행은 시작하지 않으며, API 29에서 통과한다.
- 모바일로 가는 논리 속성 축약형(49)과 flex `gap`(323)은 기준선과 같은 수준이다.
  기획 헤더·도구 행만 대체 여백을 추가했다.
- 모바일 기획 화면의 이중 프로젝트 헤더는 모바일 전용 다듬기 단계로 남긴다.
- 물리 기기 IME, 설치판 업데이트, 성능 벤치마크는 수행하지 않았다.

## 대화 결과물 탭 · 2026-10-20

AI 대화마다 오른쪽 Dockview 탭에 변경 내역·파일·계획·작업을 모은다(계약 [frontend-design §24](ux/frontend-design.md#24-대화-결과물),
기록 [구현 기록](ux/reviews/2026-10-20-agent-results-implementation.md)). Claude 편집은 SDK hunk로 줄 번호를 갖고 Codex 새 파일은 번호 붙은 추가가 됐다.
데스크톱의 기존 변경 검토 aside·대화상자와 턴 카드 인라인 diff는 결과물 탭으로 합쳤고 Android는 바뀌지 않는다.
AI가 만든 HTML은 앱 안에서 스크립트 없이 격리된 정적 미리보기로만 보이고, 상호작용은 사람이 브라우저로 연다.
프로토콜·DB 스키마 버전은 바뀌지 않았다.
