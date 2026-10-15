# EZTerminal 2.0 디자인 제안

## 상태와 소유권

r6 사용자 승인 기준이다. [승인 기록](APPROVAL.md)을 근거로 visual identity는 루트 `DESIGN.md`, 정보 구조·flow·state·responsive·a11y는 `docs/ux/frontend-design.md`에 승격했다. 활성 문서가 규범을 소유하며 이 패키지는 시각 근거와 상세 인계를 제공한다. 정확한 runtime 값은 theme/token source가 소유하고 고정 desktop handoff는 수정하지 않는다.

이번 패키지에서는 제안의 정확한 색·크기 값을 `prototype.css`만 소유한다. 문서나 별도 DESIGN.md에 값을 중복 복사하지 않는다. EZPowers의 `google-alpha-0.4.0-ezpowers-1` 형식은 검토했으나 프로젝트 AGENTS.md의 기존 문서 소유권을 우선한다. 기존 unmanaged DESIGN.md의 profile migration·managed mapping 등록은 수행하지 않았다.

## 시각 방향

차분한 현대적 workbench. 현재 작업과 문서에 가장 큰 공간을 주고 상태·요청만 강조한다. 과도한 카드 그리드·장식 수치·전체 모노스페이스를 피한다. Desktop은 긴 작업과 동시 비교, Android는 한 손 탐색과 명시적 실행을 우선한다.

Dark, Light, Matrix, High Contrast를 검토 자료에서 전환할 수 있다. Wireframe 모드는 같은 화면 구조에서 시각 장식을 제거한다. 말풍선과 터미널형은 테마와 별도로 바꾼다. 스킨 전환은 데이터나 작업 권한을 바꾸지 않는다.

## 화면과 구성요소

- Frame: 전역 레일, 상단 프로젝트 영역 전환, 단일 맥락 목록, 대화·산출물, 속성, 선택적 하단 터미널.
- Navigation: 프로젝트·기획 항목·화면·파일·세션은 각각 stable ID로 열린다.
- Conversation: 메시지·도구·승인·첨부·자식 AI track·입력·대기열.
- Planning: 문서·트리·그래프·화면 캔버스·속성·변경·기준 버전.
- Execution: 작업 목록·보드·담당·의존성·검증·수명 제어.
- Review: 기준과 결과 비교·diff 주석·수용 기준·의견·결정.
- Feedback: loading·empty·error·offline·stale·conflict·unsupported를 구분.

제품 구현에서는 기존 `src/renderer/ui/` primitives, Dockview, Monaco와 의미 기반 transcript를 우선 사용한다. 프로토타입의 HTML·CSS는 검토용이며 production에 통째로 복사하는 구현 지시가 아니다.

### 기존 production 기준과 연결

| 검토한 기준 | 연결할 v2 화면 | 구현 시 확인할 계약 |
| --- | --- | --- |
| [WorkbenchShell story](../../../../src/renderer/workbench/WorkbenchShell.stories.tsx) | D01–D03, D38–D44 | 전역 탐색·프로젝트 맥락·복구 진입점 |
| [StructuredAgentSession story](../../../../src/renderer/StructuredAgentSession.stories.tsx), [component](../../../../src/renderer/StructuredAgentSession.tsx) | D05, D16, D18 | 의미 기반 transcript, 전송 대기열, interrupt, provider-native child 읽기 전용 |
| [ProjectReview story](../../../../src/renderer/ProjectReview.stories.tsx), [ProjectEditorPanel](../../../../src/renderer/ProjectEditorPanel.tsx) | D19–D24, D29–D30 | 현재 읽기 전용 편집기에서 버전 확인 저장·변경 검토로 확장 |
| [MobileActiveSurfaces story](../../../../src/renderer/workbench/MobileActiveSurfaces.stories.tsx), [MobileAgentView](../../../../mobile/src/MobileAgentView.tsx) | M01–M16 | Android 목적지·Back·입력·재연결·PC 실행 권위 |
| [DesktopHandoff story](../../../../src/renderer/workbench/DesktopHandoff.stories.tsx) | 기존 v1 전체 | 고정 원본 보존. v2 승인 후 별도 Storybook 기준을 추가 |

이 표는 구현 담당자의 출발점이다. 현재 production story·component와 v1 snapshot을 v2 제안으로 변경했다는 뜻은 아니다.

## 반응형과 입력

Desktop 기준은 1440×900이며 800×600, 1024×720, 1200×800, 1920×1080에서도 확인한다. 영역 전환은 상단, 해당 영역의 목록은 왼쪽 한 칸을 사용한다. 좁아지면 같은 목록을 서랍으로 열고 선택 후 닫는다. 기획에서는 대화·문서를 나란히 표시하며, 독립 대화에서는 필요할 때 산출물을 펼친다. 최소 폭에서는 본문을 전환하고 입력과 읽던 위치를 보존한다. 자세한 이유와 화면별 적용은 [탐색 깊이 개선](NAVIGATION-REVIEW.md)에 기록했다.

Android 기준은 390×844이며 360×640·412×915·태블릿 폭을 확인한다. 화면 캔버스는 확대·이동할 수 있지만 일반 본문에는 가로 스크롤을 만들지 않는다. 요소 속성·노드·연결은 터치용 폼으로도 수정한다. 태블릿은 같은 목적지 순서의 레일로 전환한다.

Desktop Enter는 전송, Shift+Enter는 줄바꿈이며 IME 조합 중 전송하지 않는다. Android Enter는 줄바꿈이고 전송 버튼을 사용한다. 터미널·편집기·입력 영역의 단축키는 전역 검색이 가로채지 않는다. Back은 sheet → 하위 화면 → 목적지 root → platform 순서다.

## 접근성과 상태

본문·보조 본문의 대비 목표는 4.5:1 이상, 조작 요소 경계와 focus는 3:1 이상이다. Prototype의 일부 선택 상태를 포함해 axe와 키보드 흐름을 확인하되 이것을 제품 전체 접근성 통과로 주장하지 않는다. 터치 목표 48dp, focus 표시, 읽기 순서, dialog 초기 focus·복귀, reduced motion, 확대 150%, KO/EN 긴 문자열을 구현 검증에 포함한다.

상태 전이는 현재 정보와 입력을 보존한다. 갱신 중에는 내용을 지우지 않는다. 충돌은 버전 비교를 제공한다. 실행 불명확 상태는 기록 대조 전 자동 재실행하지 않는다. 모든 mock 수치는 '검토용 예시'다.

## 자산·근거·QA

외부 제품 이미지·로고·코드를 가져오지 않는다. 시스템 글꼴과 직접 작성한 선형 SVG 도형을 사용한다. 각 화면의 상세·wireframe 캡처는 이 프로토타입에서 생성하며 고정 v1 snapshot을 바꾸지 않는다. 후보 시안과 wireframe을 나란히 점검한 내역은 VISUAL-REVIEW.md에 남긴다.

`verify.mjs`는 59개 화면·상태·내비게이션·테마·스킨·기록의 문서용 검증을 수행한다. 현재 제품 Storybook·Playwright baseline 검증은 제품 구현 시 별도 수행한다. 새 canonical design mapping을 등록하지 않았으므로 기존 DESIGN.md profile lint/check-project/readiness migration은 이번 산출물의 완료 조건이 아니다.


## r4 정책 화면·접근성 보완

2026-10-13 확정한 [11개 운영 정책](POLICIES.md)을 반영한다. 상세 상태·Task/Session/Turn 연결·변경 계획·재시도·프로필·환경 격리·백업·Android 초안·Scene 공통 요소는 [POLICY-CONTRACTS.md](POLICY-CONTRACTS.md)를 따른다. [정책별 화면](index.html#policies)에서 정상·대기·복구를 단계별로 검토한다. r6 전체 설계 승인 이후 실제 제품 구현·검증은 별도 근거로 확인한다.

기존 시각 방향과 제안 token은 유지한다. 새 화면을 추가하지 않고 기존 59개 화면의 상태·상세에 반영한다. Desktop 800×600과 Android 360×640에서 주요 행동을 스크롤로 접근할 수 있게 하며 label, focus, 상태 알림, 색 외의 상태 설명을 제공한다. 공통 요소 예외·수정 제안·변경 계획은 원본과 영향 정보를 나란히 비교하고 좁은 폭에서는 위아래로 배치한다. 새로운 외부 자산·폰트·브랜드·의존성은 추가하지 않는다.

## r5 검토 이력

r5는 좌측 연속 출력과 출력 뒤 프롬프트를 제안했다. 사용자 보완 설명에 따라 **r6의 채팅 기반 CLI 스킨 설계로 대체**한다. [이전 PC 시안](screens/previous/D18-terminal-skin-r5.png)과 [이전 Android 시안](screens/previous/M04-terminal-skin-r5.png)은 비교용으로 보존했다.

## r6 채팅 기반 CLI 스킨

사용자가 정한 방향은 “실제 동작은 말풍선 방식 채팅이며 스킨만 CLI처럼 표시”다. **[CHAT-SKINS.md](CHAT-SKINS.md)**가 두 표현의 동작·상태·입력·반응형과 인계 계약을 소유한다. [상태별 상세 시안](index.html#chat-skins)은 Windows·Android, 말풍선·CLI, 다섯 장면을 연결한다.

시각적으로는 큰 CLI 시작 배너를 제거하고 프로젝트·담당 AI 맥락을 기존 header에 모은다. CLI 스킨은 좌측 정렬·역할 표식·조밀한 메시지·산출물 행·프롬프트형 입력을 사용한다. 메시지별 동작과 이미지·답장·승인·대기열은 동일한 채팅 요소다. 두 스킨 모두 하단 입력부와 메시지 스크롤을 분리한다. 글꼴과 테마 방향은 기존 계약을 유지하고 정확한 제안값은 prototype.css에만 둔다.

제품 구현은 기존 StructuredAgentSession의 의미 기반 기록과 공통 입력 계약에 연결한다. 이 문서와 시안은 현재 활성 DESIGN/UX 계약이나 고정 handoff를 대체하지 않으며 새로운 PTY 엔진·저장소·모델 실행기를 지시하지 않는다.
