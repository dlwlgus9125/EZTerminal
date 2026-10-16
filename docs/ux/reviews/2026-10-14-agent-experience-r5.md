# Agent 입력·프로젝트 탐색·통합 기록 r5

상태: 승인 범위 구현 및 아래 로컬 통합 검수 완료. 승인된 r1–r4 및 desktop r6 원본은 변경하지 않았다.

후속 사용자 검증에서 r5의 이전 대화 열기·목록 휠 스크롤 오류가 확인됐다.
아래 r5 통과 수치에는 연속 스크롤과 화면 아래쪽 기록을 열 때의 자동 스크롤 검사가 없었다.
해당 사용 경로를 충분히 검사했다는 근거로 사용할 수 없다. r6에서 같은 배포 EXE의 실패를
재현하고 수정했으며, 자세한 결과는 문서 끝의 후속 기록에 둔다.

## 범위와 책임

사용자는 Desktop·Android에서 프로젝트 트리를 유지하고, 앱 대화와 같은 PC의
Codex/Claude 기록을 함께 찾고 원래 제공자 세션을 Agent로 이어가기로 확정했다.
root는 기존 버그를 재현·수정하고, 세 에이전트의 UI 제안을 바탕으로 신규 탐색,
기록 화면, host 재개 기능을 병행한 뒤 전체 연결을 검수한다.

## 재현 근거

| 시나리오 | 수정 전 실행 | 관찰 |
| --- | --- | --- |
| 빈 Agent 첫 `$rev` 입력 | `pnpm test:storybook src/renderer/AgentAutocomplete.stories.tsx -t "First Message Skill"` | exit 1, 카탈로그 1개가 도착해도 `role=listbox` 없음 |
| 독립 입력창 `/`로 축소 | 같은 파일 `-t "Minimal Command"` | exit 1, 입력 `/`는 보존되지만 후보 목록 없음 |
| 1400px 프로젝트 선택 | `pnpm exec playwright test --config artifacts/r5-agent-experience/baseline.config.ts` | 기존 2.0.0 빌드에서 본문은 열리고 `workbench-sidebar`가 제거됨 |
| 1024px 단일 프로젝트로 축소 | 위 명령 `-g 1024` | 같은 sidebar 누락으로 exit 1 |

자동완성의 후보 원인은 카탈로그 조회 실패, 첫 턴 조건, 입력창 연결 누락이었다.
조회 완료 상태와 독립 composer에서도 같은 결과였고, production 입력창에 후보 선택
처리가 없음을 확인했다. 사이드바는 breakpoint 문제, Dockview 탭 재사용,
프로젝트 열기 callback의 닫힘을 비교했고, 1400px에서도 무조건 닫는 callback이 원인이었다.

## 수용 기준

- 첫 전송 전에 `/` 명령과 Codex `$` 스킬을 발견한다. Claude는 실제 `/name`을 삽입한다.
  선택은 현재 커서 토큰만 바꾸고 첨부·답장·나머지 문장을 유지한다.
- Enter는 열린 후보 선택만, Escape는 닫기만 수행한다. Tab과 한글 IME는 가로채지 않는다.
  Android Enter는 줄바꿈, 터치는 후보 선택이며 전송 버튼만 메시지를 보낸다.
- `/resume`은 공통 기록 선택기를 열며 모델 프롬프트로 전송하지 않는다.
- 프로젝트 바로 아래 일반 대화와 소프로젝트를 나란히 두고 단계의 실제 대화를 직접 연다.
  펼침·검색·최근순·선택·목록 위치를 유지한다. 1024px 이상은 sidebar를 유지한다.
- 기록은 목록과 지연 미리보기, 명시적 열기/이어가기를 분리한다. 출처 필터와 보관 필터도 분리한다.
  이미 연결된 기록은 같은 세션을 열며, 원본 CLI 기록은 같은 provider context를 재개한다.
- host가 opaque 식별자를 검증한다. 재시도·재시작·소유권·원문 보존·중복 제거를 확인한다.
  Android는 연결된 PC에서 실행하며 이전 호스트에는 지원 범위를 명확히 표시한다.

## 검증 기록

단위 테스트, 시안, 실제 provider, 패키지 실행의 근거를 구분한다. 수치는 검사별 실행 결과이며
겹치는 검사를 합산한 총 테스트 수로 표시하지 않는다.

- 전체 단위 검사: 377 파일, 3,432개 통과(기존 5개 skip). Android 단위 590개,
  OS 계약 38개 통과. 이후 발견된 연결 수정은 관련 검사를 다시 실행한다.
- 첫 입력·IME·커서 중간 삽입·Android 터치·긴 목록 키보드 이동과 프로젝트 트리
  production Storybook 17개 통과. 공용 기록·통합 화면 story 17개도 통과했다.
- 1,440px/1,024px/150%/390px 자동완성 캡처에서 수평 넘침·미처리 오류·axe 위반 0개.
  키보드로 25개 중 17번째 스킬을 고르면 화면 밖에 남는 실패를 재현해 목록 내부 스크롤로 수정했다.
- 프로젝트 child가 늦게 로드될 때 저장 위치 600이 0으로 남는 축소 검사를 확보하고 수정했다.
  기존 터미널 복귀 후 종료 버튼 누락도 실제 Electron에서 재현해 기존 종료 확인창을 연결했다.
- 실제 Codex 및 Claude: 임시 프로젝트에 새 검증 대화를 만든 뒤 원본 기록 선택 → 같은 provider
  session 재개 → 이전 marker를 다시 알려주지 않고 질문 → 원래 marker 응답을 확인했다.
  원문 import, 같은 요청 재시도, 저장소 재시작, 중복 없는 재열기도 통과했다. 각 2턴, 도구 호출 0개.
  Claude의 기존 앱 descriptor는 2.1.261이었고 현재 CLI 2.1.289와 달랐다. 사용자 설정은 바꾸지 않고
  production inspector로 현재 설치를 다시 검토한 임시 descriptor에서 검증했다.
- 일반 `pnpm e2e`: 145개 모두 통과. 이후 최종 소스로 다시 빌드해 Agent 입력·기록·
  프로젝트 진입·기존 터미널·단계 대화 연결 E2E 13개를 재실행해 모두 통과했다.
  자동완성의 내부 스크롤과 기록 이동 직전 동기 초안 저장은 각각 production story와
  실제 unmount를 포함한 단위 검사로 확인했다. 관련 초안 검사 37개가 통과했다.
- 원격 protocol/bridge 205개, 모바일 transport 및 고정 r4 wire 호환 202개 통과.
  새 phone의 첫 auth 한 번으로 구 host에 연결해 목록·본문·명시적 PTY 재개까지 확인했다.
  구 host는 protocol 12로 연결되므로 v13/v14 planning/workflow 및 v15 Agent adoption은
  host 업데이트가 필요하다. 인증 거절 뒤 자동 downgrade 재접속이나 mutation 재전송은 없다.
- 최종 `pnpm typecheck`, 루트 lint, 관련 모바일 lint, 문서 검사, 프로젝트 맵 7개와
  기존 승인·페어링·디자인·desktop handoff·Claude provider guard를 통과했다.
- Android API 29의 소유한 read-only 에뮬레이터에서 운영용 웹 자산을 담은 debug wrapper를
  실행했다. 스킬 터치 삽입, native Enter 줄바꿈, preview → 목록 → 같은 초안으로 native Back,
  프로젝트 행에서 같은 대화 열기를 확인했다. 입력/select 준비만 DOM 이벤트를 사용했다.
  실제 remote bridge와 검토된 fake Codex를 사용했고 모델 전송은 0회, 미처리 오류 0개였다.
- 같은 소스의 최종 서명 APK를 별도로 설치하고 설치된 bytes의 SHA256 일치, non-debuggable,
  정상 foreground·실행 유지·오류 없는 logcat·첫 화면을 확인했다. Windows 최종 EXE 패키지의
  interpreter·실제 포인터 popout·PTY·SSH·OS clipboard 검사 5개도 통과했다.

## 설치파일과 검수 한계

산출물은 `artifacts/r5-release-2026-10-14/`에 있으며 이전 r4 산출물은 보존했다.

- Windows: `EZTerminal-Setup-2.0.0-r5.exe`
- Android: `EZTerminal-Android-2.0.0-vc76-r5.apk`
- 소스 식별자: `r5-local-2e9841f78b687ee4` (작업 트리 SHA256 기반, Git commit ID가 아님).
  두 빌드가 끝날 때까지 소스가 동일함을 확인했다. 이 완료 기록은 빌드 후 갱신했다.
- `release-manifest.json`, `SHA256SUMS.txt`, `windows/windows-build-report.json`,
  `android/android-build-report.json`에 파일 해시·서명·빌드 결과를 기록한다.
- 실제 provider 근거: `artifacts/r5-agent-experience/native-history-proof.json`.
  Android 입력 근거: `artifacts/r5-android/run/agent-experience-report.json`.
  서명 APK 설치 근거: `artifacts/r5-release-2026-10-14/android/installed-smoke-report.json`.

Windows는 미서명 로컬 빌드다. EXE 패키지를 실행했으며 설치 마법사를 통한 설치/업데이트는
검사하지 않았다. Android는 기존 릴리즈 키로 서명했지만 물리 기기의 IME·업데이트 검증은
수행하지 않았다. 실제 provider 재개와 Android UI 입력은 각각 검증했으며 물리 휴대폰에서
실제 provider까지 연결한 종단 검증으로 확대하지 않는다. 공개 배포·성능 측정은 실행하지 않았다.
검증용 profile과 read-only 에뮬레이터는 정리했고 사용자 대화와 기기 데이터는 변경하지 않았다.

## 시안

동작하는 production stories: `Agents/Autocomplete`, `Agents/Conversation history`,
`Projects/Conversation tree`, `Production/Navigation/Conversation workbench`.
시안 fixture의 데이터와 실제 provider 실행 증거는 구분한다.

- [Desktop 탐색](2026-10-14-agent-history/desktop-navigation-dark-en.png)
- [Desktop 기록 미리보기](2026-10-14-agent-history/desktop-history-dark-ko.png)
- [Android 탐색](2026-10-14-agent-history/android-navigation-dark-ko.png)
- [Android 기록 미리보기](2026-10-14-agent-history/android-history-light-ko.png)

기록 창 하단 버튼이 잘리던 상태는 실제 캡처에서 확인해 수정했다. Desktop의 동작 버튼은
1,000px 화면의 y839–871, Android는 844px 화면의 y724–768 안에 표시된다.

## r6 후속 수정 · 이전 대화 열기와 스크롤

`ProjectConversationTree`의 `onScroll`이 React 상태 갱신 함수 안에서
`event.currentTarget.scrollTop`을 읽었다. React가 이벤트 처리를 끝내고 `currentTarget`을
null로 돌린 뒤 갱신 함수가 실행되면서 TypeError가 발생했다. 휠 스크롤뿐 아니라 아래쪽
이전 대화를 열기 위해 행을 자동 스크롤하는 경우에도 프로젝트 화면의 오류 경계가 표시됐다.

수정은 이벤트 처리 중 숫자 위치를 먼저 읽고, 갱신 함수에서는 그 숫자만 사용하는 것이다.
위치가 같을 때는 기존 상태를 반환한다. 기록 삭제나 오류 숨김, 재시도 추가로 우회하지 않았다.

- 수정 전 r5 EXE: 프로젝트 24개 연속 스크롤과 긴 CLI 대화 24개 중 마지막 기록 열기 모두
  같은 `scrollTop` TypeError와 `.feature-load-error`로 실패했다. 이 두 검사는
  `e2e-packaged/project-history-navigation.spec.ts`에 남겼다.
- 최소 재현: 프로젝트 하나에 스크롤 이벤트 두 번만 전달해도 같은 예외가 발생했다.
  `ProjectConversationTree.test.tsx`의 회귀 검사를 수정 전 red, 수정 후 green으로 확인했다.
- 수정 r6 EXE: 전체 패키지 검사 7개 통과. 두 사용자 시나리오는 각각 3회씩 반복해 6개 모두
  통과했고 렌더러 오류 0개였다. 본문 스크롤, 이전 메시지 더 보기, 닫고 목록으로 복귀도 포함한다.
- 관련 일반 E2E 16개, typecheck, 변경 파일 lint, 디자인 guard, 프로젝트 맵 7개 통과.
  전체 단위 첫 실행에서 기존 backend 검사 3건이 실패했으므로 분리 재검사(15개) 후
  전체 검사를 다시 실행했다. 최종 377 파일·3,463개 통과, 기존 5개 skip이다.
- Windows 수정 설치파일: `artifacts/r6-release-2026-10-14/EZTerminal-Setup-2.0.0-r6.exe`.
  미서명 로컬 빌드이며 r5 설치파일을 덮어쓰지 않았다. 이번 후속 배포 대상은 Windows이고,
  공유 소스 수정이 기존 Android 설치파일에 소급 반영되지는 않는다.
- 실행 로그·red/green 근거: `artifacts/r6-history-crash/`. 빌드 식별과 파일 해시는
  `artifacts/r6-release-2026-10-14/release-manifest.json`에서 확인한다.
