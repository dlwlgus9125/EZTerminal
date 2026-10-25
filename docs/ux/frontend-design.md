# EZTerminal 2.0 UX 계약

> 문서 상태: **활성 규범 계약**
>
> 이 문서는 Electron desktop과 Android client의 정보 구조, navigation, layout, 상태, responsive
> behavior와 접근성 계약이다. Visual identity와 미학적 판단은 루트 [`DESIGN.md`](../../DESIGN.md)가,
> 정확한 runtime 값은 theme·token source가 소유한다. 화면 구현, Storybook, 접근성 검사와 시각 스냅샷은
> 두 계약에 동의해야 한다. 코드와 문서가 어긋나면 회귀인지 의도된 변경인지 먼저 결정하며, 코드를 이유로
> 문서를 자동 수정하지 않는다.

## 0. 이 문서를 읽는 법 (ux2 개편 중)

2026-10-23 시작한 ux2 개편([기록](overhaul/README.md))이 이 문서를 전면 교체했다. 개편 전 원문은
[`reviews/2026-10-23-ux2-baseline/frontend-design.md`](reviews/2026-10-23-ux2-baseline/frontend-design.md)에
그대로 있다. 2026-10-24 사용자가 방향 **Board + Desk**(프로젝트 판 + 작업 모드 + 터미널, 계기판 시각 언어)를
Storybook 실물로 확인하고 승인했다("승인 이대로 실물 구현해줘"). 관문 ①의 A/B 레일 안은 이 방향으로 대체되었다.

- **1부(§1–§9)**는 정보 구조와 흐름이다. 각 절의 **구현 상태**가 `I1`이면 이번 셸 단계(`feat/ux2-desk-shell`)에서
  구현되었고, `I2`(흐름)·`I3`(터미널)·`I4`(Android)·`I5`(정리)면 그 단계에서 구현된다. 구현 전까지 제품은 개편 전
  원문의 해당 배치를 유지하며, 그 차이는 회귀가 아니다.
- **2부(§10–§27)**는 배치와 무관하게 유지되는 기능 영역 계약(토큰 사용, 상태, 접근성, PC Control,
  편집기, Explorer, Project Map, 채팅, 결과물, 흐름 캔버스 등)이다. 배치를 말하는 문장은 1부로 옮겼다.

## 1. 범위와 우선순위

이 문서는 정보 구조, navigation, layout, responsive behavior, 접근성, localization과 UI 상태를 소유한다.
셸 실행, IPC, pairing, 원격 protocol, process lifecycle은 [`architecture.md`](../architecture.md)와
`docs/design/` 계약이 소유한다.

**제품 방향(2026-10-23 사용자 확정).** Desktop은 AI 대화로 개발하는 작업을 중심에 둔 workbench이고,
Android는 같은 PC 작업을 확인·승인·이어가는 companion이다. 개편 전 "기본 작업은 Terminal, Agent는
선택 기능"(이전 §10)은 이 방향으로 **의도적으로 바꾼다**. 실제 터미널은 기존 의미·수명·키 동작을 그대로
유지하며 시각 일관성만 맞춘다.

최적화할 여정(우선순위 순):

1. **J1 AI 대화로 개발** — 프로젝트를 열고, 대화를 시작하거나 이어가고, 승인·질문에 답하고, 결과·변경과
   하위 에이전트를 확인한다.
2. **J2 소프로젝트 흐름** — 캔버스에서 단계를 설계하고, 실행하고, 승인하고, 단계 대화·결과·통합을 확인하고,
   같은 설정으로 다시 실행하거나 반복 일정에 맡긴다.
3. **J3 폰에서 확인·승인·이어가기** — 상태를 보고, 요청에 답하고, 대화를 이어간다.

결정 우선순위:

1. 같은 기능에는 **하나의 소유 화면**만 둔다. 다른 곳은 그 화면으로 가는 링크·개수만 보여 준다.
2. 같은 동사에는 같은 UI를 쓴다. "새 대화", "위임", "승인", "파일 열기"는 어디서 시작해도 같은 화면과 같은
   후속 흐름으로 이어진다.
3. 작업 공간을 크롬보다 우선한다(§4.1 크롬 예산).
4. 선택, preview, insertion, drop과 navigation은 명시적 실행을 뜻하지 않는다.
5. navigation 중 terminal controller, draft, scroll, xterm geometry, reconnect와 selection을 보존한다.
6. Matrix/CRT 정체성보다 가독성, truthful state와 reduced motion을 우선한다.
7. keyboard, pointer, touch와 assistive technology가 같은 작업을 끝낼 수 있어야 한다.
8. 한국어와 영어를 동등한 제품 언어로 취급하며, 한 언어 화면에 다른 언어 라벨을 섞지 않는다.

범위 밖: 개편은 기능을 정돈할 뿐 새 기능(파일 편집, 독립 로드맵 메뉴·간트차트 등)을 추가하지 않는다. 일반 대화와
터미널에 기획 작성을 강제하지 않는다. 사용자가 실물에서 요청한 흐름 기능(단계 노력 설정, 다시 실행, 반복 일정)은
I2의 범위다. 새 설치 기본 테마·채팅 스킨은 [`DESIGN.md`](../../DESIGN.md)가 소유하며 기존 사용자의 보기·테마·
세션·기록은 덮어쓰지 않는다.

## 2. 용어

> 구현 상태: I1(셸 라벨). 나머지 문구는 해당 단계에서 정리한다.

같은 대상은 ko·en 각각 한 단어만 쓴다. 코드의 domain 이름(`Workspace` 등)은 UI에 노출하지 않는다.

| 대상 | 용어 |
|---|---|
| 프로젝트 홈 화면 | **판 / Board** |
| 판 밖에서 일하는 화면(목록 + 도크) | **작업 모드**(라벨로 쓰지 않음) |
| 작업 모드 왼쪽 열 | **작업 목록 / Work list** |
| 사람이 판단할 요청(승인·질문) | **나를 기다리는 것 / Waiting for me**. 전체(완료 알림·터미널 에이전트 포함)는 **받은 요청 / All requests** |
| 분할·배치 프리셋·작업 공간을 고르는 메뉴 | **배치 / Layout**(버튼 이름은 기존 `워크스페이스`, I5에서 정리) |
| 함께 열어 둔 탭 묶음 | 작업 공간 / Workspace(배치 메뉴 안) |
| 대화를 만드는 동작 | **새 대화 / New conversation** |
| 목록에서 연 뒤 고정 전까지의 탭 | **미리보기 / Preview**, 고정은 **탭으로 고정 / Keep open** |
| 하위 실행 주체 | 하위 에이전트 / Sub-agent |
| 지난 대화와 CLI 기록 | 모두 보기 · 지난 대화와 CLI 기록 / All · past conversations and CLI history |

## 3. 정보 구조 원칙

> 구현 상태: I1–I5.

- **한 기능, 한 소유 화면.** 기능별 소유 화면은 §5 표가 정한다.
- **프로젝트가 집이다.** 위 막대의 프로젝트 탭이 판을 고르고, 판은 그 프로젝트의 흐름·대화·터미널과 나를
  기다리는 것을 한 화면에 모은다. 무엇을 열면(대화·터미널·흐름) 작업 모드가 되고, 왼쪽 작업 목록이 판을
  한 열로 접은 모습이 된다.
- **목록은 하나.** 대화를 나열하는 곳은 판(카드)과 작업 목록(행)이며 둘은 같은 모델(`shell-model`)을 읽는다.
  지난 대화·CLI 기록은 그 목록의 "모두 보기"다.
- **Project → Workspace → Session은 데이터 맥락이다.** 화면 깊이와 일치시킬 의무는 없다. 작업 폴더는
  대화의 속성이며 입력창 칩에서 보인다.
- **stable ID 재사용.** 이미 열린 대화·파일·결과는 새 탭을 만들지 않고 그 탭과 요청 위치를 재사용한다.
  대화 탭 중복 판단은 대화 정체성(alias 포함) 하나로 한다.
- **기능 유지.** 개편으로 기능이 사라지지 않는다. 지금 기능의 새 자리는 §4.6 표가 정한다.

## 4. Desktop 셸 — Board + Desk

> 구현 상태: I1(`src/renderer/shell/`, `App.tsx`). 스토리: `Compositions/Shell 2.0`.

### 4.1 Anatomy와 크롬 예산

위에서 아래로 **위 막대 → (판 | 작업 모드)** 이고, 상태 표시줄은 없다.

- **판**: 프로젝트 머리(이름 · 경로 · 파일 · 프로젝트 설정) → 흐름 · 대화 · 터미널 줄 → 오른쪽 칸 "나를 기다리는 것"과
  "다른 프로젝트" → 아래 시작 막대(제품 새 대화 입력창 + 새 터미널 + 새 흐름).
- **작업 모드**: 왼쪽 작업 목록 | 도크(Dockview). 대화 본문 위 고정 크롬은 **위 막대 + 대화 머리줄 2줄**이다.
  그룹에 대화 탭 하나뿐이면 탭 줄을 숨기고(§4.4), 여러 탭·터미널·분할이면 탭 줄이 더해진다(최대 3줄).
- 판이 보이는 동안 도크는 **mounted 그대로** 숨는다(visibility·opacity·inert, 흐름 밖 배치). 터미널 상태, 초안,
  숨은 패널은 유지되고 작업 모드로 돌아오면 refit과 focus 복원을 한다. OpenClaw 네이티브 창도 판 아래로 숨는다.
- 좁아지면 부가 조작은 메뉴로 옮기고 **줄을 늘리지 않는다**.

지원 viewport는 800×600, 1024×720, 1200×800, 1440×900과 1920 reference다. 100%와 150% UI scale 모두에서
document-level 가로 scroll, terminal overlap, 접근 불가능한 primary action이 없어야 한다. 셸 크기는 rem이라 UI
scale을 따른다.

### 4.2 위 막대

왼쪽부터 **워드마크(버전은 tooltip) · 프로젝트 탭 · `+` · (작업 모드) 기다리는 것 N · 찾기 · (작업 모드) 배치 ·
원격 램프 · 설정 · 창 제어**. 위 막대는 창 drag 영역이다.

- 프로젝트 탭: 고정 프로젝트 → 최근 활동 순으로 최대 5개, 선택된 프로젝트는 항상 탭을 가진다. 탭에는 기다리는
  수(호박색)와 오류로 멈춘 대화가 있으면 빨간 램프. 탭을 누르면 그 프로젝트의 판.
- `+`는 프로젝트 화면(추가·편집·삭제·고정·CLI 기록·워크트리)을 사이드바로 연다.
- 기다리는 것 N(작업 모드에서만): 첫 항목을 답하는 곳으로 간다(대화 승인·질문은 그 대화, 흐름 승인은 그 단계를 연
  흐름 화면, 막힌 터미널 CLI 에이전트는 받은 요청). 없으면 받은 요청을 연다. 수는 host가 계산한 하나다(§6.3).
- 원격 램프: 판에서는 글자(`원격 · 대기`, 제어 중이면 기기 이름과 RTT), 작업 모드에서는 램프만. 누르면 원격 화면.
- 좁은 창에서는 프로젝트 탭이 먼저, 그다음 찾기가 아이콘까지 줄어든다. 위 막대는 겹침 사이드바가 열려도 쓸 수
  있다(설정 스위치로 닫기).
- 현재 프로젝트 규칙: 메인 창의 활성 탭이 프로젝트를 가진 대화·터미널·흐름이면 그 프로젝트로 바뀌고, 프로젝트
  없는 탭(일반 터미널, OpenClaw)은 그대로 둔다. 판/작업 모드와 선택 프로젝트는 기기별로 저장되며(렌더러 저장소,
  종료 시 flush) 배치 스키마는 바꾸지 않는다. 처음 시작에는 프로젝트가 있으면 판, 없으면 작업 모드(프로젝트
  목록이 오기 전에 이미 누르거나 입력했으면 그 자리 그대로).

### 4.3 작업 목록과 사이드바

- 작업 목록(1100px 이상, 17.25rem): `← 판` · 프로젝트 이름 → **나를 기다리는 것**(승인·질문 행, "받은 요청 모두
  보기") → **대화**(`+` 새 대화, 램프·제공자·상태, 하위 에이전트는 앞에 있는 대화나 작업·대기 중일 때만 펼침,
  "모두 보기 · 지난 대화와 CLI 기록") → **흐름**(소프로젝트, 실행 # 와 단계 램프) → **터미널**(Ctrl `, `+`) →
  아래 "다른 프로젝트" 한 줄과 도구 줄(파일 · 모니터 · OpenClaw · 원격·폰 · 설정).
- 1100px 미만에서, 그리고 결과물을 넓게 보는 동안은 **접힌 띠**(3.625rem): 판 · 목록 펴기 · 기다리는 것(수) · 새 대화 · 새 터미널 · 도구. 목록
  펴기는 같은 목록을 도크 위에 겹쳐 열고, 무엇을 고르거나 Escape면 닫힌다.
- 목록에서 대화를 열면 **미리보기 탭**: 같은 그룹의 미리보기 자리를 바꿔 가며 보고, 이동·더블클릭·이름 바꾸기·
  "탭으로 고정"·입력·보내기로 고정된다. 새 대화·`/clear`·알림·기록 대화상자·대화 안 링크는 고정 탭으로 연다.
  미리보기 여부는 세션 동안만 기억하며 저장된 배치에 쓰지 않는다.
- 도구는 기존 `SidebarShell` 하나에 목적지 하나(파일, 모니터, 원격, OpenClaw, 설정, 프로젝트·받은 요청),
  280–440px. 1200px 미만에서는 작업 목록(또는 띠) 끝에서 시작하는 overlay와 scrim이며, overlay 동안 목록·띠와
  위 막대는 계속 쓸 수 있다. 닫으면 invoker로 focus를 돌린다.
- 각 목적지는 loading, empty/unavailable, error/offline, success 상태를 가진다(개편 전 규칙 그대로).

### 4.4 도크·탭 줄과 대화 머리줄

- 그룹의 유일한 탭이 대화면 **탭 줄을 숨긴다**. 대화 머리줄이 탭을 대신한다: 미리보기면 📌(탭으로 고정), ⋯ 메뉴의
  "탭" 절(탭으로 고정 · 오른쪽으로 나누기 · 아래로 나누기 · 새 창/메인 창으로 · 탭 닫기). 닫기는 기존 닫기 안전
  장치를 거친다. 다른 탭이 합류하면 탭 줄이 다시 보인다.
- **배치 메뉴**(작업 모드 위 막대): 작업 공간(전환·새로·이름·닫기·탭 이동·입력할 영역·집중 보기), 빠른 배치(위아래 ·
  2×1 · 1+2 · 단일), 분할, 저장 배치(저장·적용·시작 시 열기·삭제). 개편 전의 워크벤치 바와 헤더 워크스페이스 메뉴를
  합쳤다. 배치 전환은 non-destructive Dockview transaction이다.
- 탭 drag, 별도 창, 탭 메뉴의 `새 창으로 이동`·`메인 창으로 이동`과 프로젝트 터미널 탭 제목·Badge 규칙은 개편 전과
  같다.

### 4.5 판

- 흐름 줄: 소프로젝트마다 실행 #·상태 램프·이름·승인 방식, 단계 램프 사슬, `승인 보기`(승인 대기) 또는 `흐름 보기`.
  다시 실행·단계 대화 바로 열기·반복 일정은 I2.
- 대화 줄: 최근 대화 카드(램프 · 제공자 · 상태, 하위 에이전트 수). 기다리는 대화는 호박색 판. 단계 대화는 흐름에서
  보이므로 여기서 뺀다.
- 터미널 줄: 이 프로젝트와 프로젝트 없는 터미널, `+ 새 터미널`.
- 나를 기다리는 것: 명령·파일 변경·도구 승인은 판에서 바로 **허용 / 거부**(`permission.resolve`), 질문·계획은 `답하기`로
  대화를 연다. 실패하면 카드 안에 이유를 보인다.
- 시작 막대: 제품 새 대화 입력창(프로젝트별 초안 유지, 설정 칩 그대로). 보내면 그 대화가 **고정 탭**으로 열리며 작업
  모드가 된다. 좁으면 설정 칩이 다음 줄로 내려간다.
- 프로젝트가 하나도 없으면 "프로젝트를 고르세요"와 `프로젝트 추가`.

### 4.6 지금 기능의 새 자리

| 개편 전 | 새 자리 |
|---|---|
| 헤더 워드마크·버전 칩 | 위 막대 워드마크(버전은 tooltip, 설정 > 정보) |
| 헤더 새 터미널 / 로봇 새 대화 | 판 시작 막대, 작업 목록 `+`(대화·터미널), 접힌 띠, Ctrl+` |
| 헤더 Command Center | 위 막대 찾기(Ctrl K) |
| 헤더 워크스페이스 메뉴 + 워크벤치 바(작업 공간·빠른 배치) | 작업 모드 위 막대 배치 메뉴 |
| 헤더 NEON 효과 · 상태 표시줄 FX | 설정 > 모양 |
| 헤더 에이전트 알림 · 상태 표시줄 대기 수 · 레일 받은 요청 | 위 막대 기다리는 것 N · 판 오른쪽 칸 · 작업 목록 첫 절과 "받은 요청 모두 보기" |
| 레일 프로젝트 + 프로젝트 사이드바 | 위 막대 프로젝트 탭과 `+`(같은 프로젝트 화면), 판 머리 파일·프로젝트 설정 |
| 레일 도구 메뉴(탐색기·모니터·원격·OpenClaw)와 설정 | 작업 목록 도구 줄(접힌 띠 포함), 설정은 위 막대에도 |
| 상태 표시줄 원격·PC 제어·RTT | 위 막대 원격 램프, 원격 제어 중 배너는 그대로 |
| 상태 표시줄 언어 | 설정 > 일반 |

### 4.7 터미널 입력과 복사

Active pane composer는 작은 폭에서 document overflow 없이 줄어든다. terminal-specific keyboard, paste와
close safety를 앱 크롬 단축키가 가로채지 않는다(예외: Ctrl+`, §8). 선택된 terminal text의 context-menu Copy와
keyboard alias는 main, split, 별도 창에서 같게 동작하며, 성공·실패 toast는 동작을 시작한 document에 표시하고 선택
내용을 feedback에 노출하지 않는다. 선택 없는 `Ctrl+C`의 PTY/Codex 의미는 바꾸지 않는다. Transport와 selection
snapshot의 상세는 [`terminal-clipboard.md`](../design/terminal-clipboard.md)가 소유한다.

### 4.8 설정, resource profile, 종료

> 구현 상태: 현행(설정 분류 재정리는 B3·B5).

- 설정 분류는 일반, 모양, 터미널·안전, **AI**(개편 전 에이전트), 연동, 정보·진단이다. 일반은 언어·density·
  resource profile·수명, 모양은 theme·font·CRT·채팅 스킨, 터미널·안전은 terminal behavior와 paste/clipboard/
  close 안전, AI는 대화 provider·AI 프로필·CLI 실행기·터미널 상태 연동·자동화, 연동은 원격 접속·페어링·
  OpenClaw, 정보·진단은 version과 diagnostic metadata를 소유한다.
- 대화 provider(Codex, Claude)는 같은 compact row family로 보이되 단순 toggle로 축약하지 않는다. `설치 확인`이
  찾은 executable path, version, 고정 argv, 전달되는 환경 변수의 **이름만**, 지원 capability와 provider 공지를
  검토한 뒤에만 `활성화`한다. 검토 정보가 바뀌어 digest가 맞지 않으면 실행하지 않고 다시 검토하게 한다.
  활성 row는 `Ready` 또는 구체적인 복구 가능한 오류와 `비활성화`를 보인다. 설치 없음, 확인 중, 확인 실패,
  검토 대기, 활성화 중, 활성, 비활성화 중은 text와 control 상태로 구분하며 이전 성공 상태를 loading으로
  가장하지 않는다. 사용하지 않는 provider는 중립적인 `사용 안 함`이며 준비 오류를 반복 경고하지 않는다.
- Claude는 활성화 전에 API key environment, 기존 CLI environment, 기존 claude.ai login 중 하나를 고르게 한다.
  credential/token/cookie 값을 입력·표시하는 필드는 만들지 않는다. 약관 확인과 상용 사용 승인 확인은 필수,
  기존 claude.ai login은 Anthropic third-party 사용 사전 승인 확인이 따로 필요하다. inline 설명과 공식 문서
  link를 함께 제공하고 checkbox 하나로 합치지 않는다. 비활성화는 비밀 없는 동의 기록과 daemon provider 상태를
  비활성화하되 기존 CLI 로그인을 삭제하지 않는다. 검토 도중 실행 identity가 바뀌면 새 identity를 다시 확인한다.
- 터미널 상태 연동(activity hook)은 대화 provider를 켜는 기능으로 오해하지 않게 별도 subsection이다. provider
  setup은 keyboard로 row → 세부 검토 → 인증 경로 → 필수 확인 → primary action 순서로 이동하고, 펼친 상세는
  heading/fieldset/status semantics를 쓴다. 좁은 화면에서는 metadata label/value를 한 열로 쌓고 path와 argv는
  줄바꿈하되 document 가로 overflow를 만들지 않는다. Storybook 설정 fixture는 설치 없음·검토 대기·Claude 승인
  조건·Ready·오류를 고정 입력으로 제공하고, component test는 stale review, 중복 제출, 조건부 승인 checkbox와
  credential 비노출을 검증한다.
- Resource profile은 기능을 제거하지 않고 optional 화면 preload와 관찰 refresh 비용만 고르는 device-local
  설정이다. Balanced(기본: idle 시 preload, 표준 주기), Low resource(intent 시 preload, 허용 목록만 2배 주기),
  High responsiveness(설정 복원 직후 preload, 표준 주기). 선택은 즉시 저장되고 다음 refresh 예약부터 적용한다.
  불러온 module은 강제로 unload하지 않으므로 Low resource의 완전한 메모리 회수는 다음 앱 시작부터라고 안내한다.
  어느 선택도 timeout, reconnect/liveness, command cancellation, backpressure, capture lease나 위험한 pane 닫기
  확인을 느리게 하지 않는다.
- Windows main 창의 native close와 frameless close는 기본적으로 명시적 Quit과 같은 종료 경로로 terminal·Agent
  session을 정리한다. 일반의 `계속 실행`을 켠 경우에만 창을 숨기고 user-level daemon과 tray를 유지하며, tray
  click과 Open은 같은 main 창을 restore·focus한다. `시작 시 실행`은 별도 상태지만 첫 schedule/heartbeat 활성화에서
  두 설정을 함께 켤지 설명하고 동의를 받는다. 취소하거나 OS 등록이 실패하면 automation도 켜지 않는다. 메뉴와
  tray의 `Quit…`은 설정과 무관하게 모든 session을 중단한다는 확인을 쓰며 Cancel이 기본이다. 숨김과 종료를 같은
  label이나 icon으로 표현하지 않는다.

## 5. 기능별 소유 화면

> 구현 상태: 표의 "단계" 열.

| 기능 | 소유 화면 | 주 진입 | 다른 곳에 남는 것 | 단계 |
|---|---|---|---|---|
| 프로젝트 홈 | **판**(§4.5) | 위 막대 프로젝트 탭, 작업 목록 `← 판`, 다른 프로젝트 | — | I1 |
| 대화 목록 | 판 대화 줄 + 작업 목록 대화 절(같은 모델) | 판, 작업 목록 | 노드의 연결 대화 칩 | I1 |
| 지난 대화·CLI 기록 | 기록 대화상자(같은 통합 기록) | 작업 목록 "모두 보기", 대화 ⋯ 이전 대화, Ctrl+K | — | I1(진입), 이후 통합 |
| 새 대화 | 초안 대화(판 시작 막대 또는 초안 탭) | 판 시작 막대, 작업 목록·띠 `+`, `/new` | — | I1 |
| 나를 기다리는 것 | 판 오른쪽 칸(바로 허용·거부) + 작업 목록 첫 절 | 위 막대 기다리는 것 N, 프로젝트 탭 수 | 대화 안 승인 카드 | I1, I2-5(흐름 승인·host 계산) |
| 받은 요청 전체 | 받은 요청 사이드바(완료 알림·터미널 에이전트 포함) | 작업 목록 "받은 요청 모두 보기" | — | I1 |
| 위임 | 대화 입력창의 위임 시트(같은 composer) | 대화 ⋯ | — | 현행 |
| 결과·변경 검토 | **결과 탭**(대화 옆 분할, 범위 표시) | 대화 머리줄 [결과물], 턴 변경 요약 | — | 현행 |
| 파일 | 파일 사이드바 + 파일 탭 | 작업 목록 도구 줄, 판 머리 파일(프로젝트 파일) | 결과 탭 안 미리보기 | I1(진입) |
| 프로젝트 관리 | 프로젝트 사이드바(추가·편집·삭제·고정·CLI 기록·워크트리) | 위 막대 `+`, 판 머리 프로젝트 설정 | — | I1(진입) |
| 소프로젝트·캔버스·실행 | 흐름 탭(캔버스 + 실행 막대) | 판 흐름 줄, 작업 목록 흐름 절, 판 `새 흐름` | — | I1(진입), I2(실물 흐름) |
| 배치·작업 공간·분할 | 배치 메뉴 | 작업 모드 위 막대 | 탭 메뉴 분할, Alt+Shift+=/- | I1 |
| 원격 | 원격 사이드바(맨 위 원격 접속 스위치, 페어링, 기기, PC 제어, SSH) | 위 막대 원격 램프, 도구 줄 | 설정 → 연동의 같은 스위치 | I1(진입) |
| 모니터, OpenClaw | 각 사이드바(OpenClaw 채팅은 도크 패널) | 도구 줄 | — | I1(진입) |
| 터미널 | 터미널 탭 | Ctrl+`, 작업 목록·띠·판의 새 터미널 | — | I1(진입), I3(모양) |
| 설정 | 설정 사이드바(§4.8 분류) | 위 막대 설정, 도구 줄, Ctrl+K | — | 현행 |

## 6. 핵심 흐름

### 6.1 새 대화

> 구현 상태: B1(일반), B3(단계·흐름 편집·구성 대화). 연결 방식 **결정 대기(D①-4)**.

- 모든 진입점은 같은 함수(`openConversationDraft(seed)`)를 부르고 **seed**(프로젝트, 작업 폴더, 연결)만 다르다.
  생성 화면은 초안 대화 탭 하나이고 별도 생성 폼·모달·"Agent 만들기" 단계는 없다.
- 초안은 입력창 아래 맥락 칩 한 줄(프로젝트 · 작업 폴더 · AI 프로필 · 연결)과 입력창이다. 첫 메시지 전송이
  대화를 만들고 같은 탭이 그 대화가 된다. 선택·취소만으로 entity나 process를 남기지 않는다.
- 작업 폴더 기본값: seed의 작업 폴더 → 프로젝트의 마지막 사용 폴더 → 프로젝트 기본 루트 → 없으면 "폴더
  선택"을 강조하고 전송을 비활성화한다. 사용할 수 없는 폴더에서는 전송을 막고, main이 제출 직전에 접근 상태를
  다시 검증한다.
- 단계·흐름 편집·소프로젝트 구성 대화는 같은 초안에 **연결 칩**을 붙여 연다. "AI와 흐름 편집"은 캔버스 옆
  분할로 연다. 연결 확정은 기본적으로 기존의 복구 가능한 2단계(생성 → 연결)를 초안이 이어받는다(D①-4).
- 위임과 검토 맡기기는 새 대화가 아니라 현재 대화의 하위 에이전트를 만드는 **위임 시트**다(같은 입력창, 동사
  "위임").
- Desktop은 Enter 전송, Shift+Enter 줄바꿈, IME 조합 중 Enter 무시. Android는 키보드 Enter 줄바꿈, 전송
  버튼으로 시작.
- 라벨은 "새 대화" 하나다(§2).

### 6.2 대화 이어가기와 기록

> 구현 상태: B1.

- 대화 목록의 대화 행은 그 대화 탭을 열거나 이미 열린 탭으로 간다.
- **기록**은 대화 목록의 범위다. 앱 대화와 Claude/Codex CLI 기록을 출처 배지와 함께 한 목록에 보이고,
  행 동작으로 대화 열기·앱에서 이어가기·터미널(CLI)에서 이어가기를 제공한다. 별도 기록 대화상자와 CLI 기록
  하위 화면은 두지 않는다. `/resume`과 대화 ⋯의 "이 프로젝트 기록 보기"는 이 범위를 연다.
- 기록 화면은 loading/long-running 중 기존 목록을 지우지 않고 busy를 표시하며, empty, load error와 retry를
  구분한다. 행·Back·retry·더 보기는 keyboard와 pointer로 같게 동작하고 icon-only 동작은 localized accessible
  name을 가진다.
- 읽기만으로 provider를 실행하지 않는다.

### 6.3 나를 기다리는 것

> 구현 상태: I1(판·작업 목록·위 막대, 대화 승인·질문). I2-5: host가 계산한 요약(`DaemonSnapshot.attention`,
> `src/shared/host-attention.ts`)을 위 막대·프로젝트 탭 수·판 오른쪽 칸·작업 목록과 Android 탭 배지가 같이 읽는다.
> 포함: 대화 승인·질문, 흐름 단계 승인(자동 승인 실행은 host의 자동 결정이 거절됐을 때만), 막힌 터미널 CLI 에이전트.
> 완료·오류 알림은 기기별로 받은 요청에만 남는다. 요약이 없는 옛 host에서는 예전 셈(대화 승인 + 터미널 에이전트).

- 승인, 질문, 입력 대기, 조치가 필요한 실패, 계획 검토, 흐름 단계 승인을 한 큐로 보인다. 행은 프로젝트·대화
  맥락, 요청 이유, 실행 대상을 가지며 누르면 해당 대화의 요청 위치로 간다. 안전한 항목은 행에서 바로 응답할
  수 있고, 위험한 항목은 상세 확인을 거친다.
- 배지 수는 host가 같은 미해결 요청 ID 집합으로 계산한 한 값이며 데스크톱 레일과 Android 탭이 같은 수를 보인다.
- 완료 알림을 이 큐에 둘지, 읽음 상태를 기기 사이에 동기화할지, "읽음"과 "응답 완료"를 어떻게 구분할지는
  D①-8에서 정한다.
- 다른 기기에서 처리된 요청은 즉시 처리 완료로 보인다.

### 6.4 결과·변경 검토·파일

> 구현 상태: B2.

- 대화의 결과는 대화 옆 결과 탭이다(배치 규칙은 §24). 결과 탭은 범위(이번 응답 / 대화 전체 / 작업 폴더 /
  실행 단계)를 명시하며, 기록 조각을 완전한 diff처럼 보이지 않는다.
- 파일은 파일 탭 하나로 연다. 파일 목적지, Command Center 파일 행, 터미널 경로 링크, 결과의 파일, Project Map
  근거가 모두 같은 open command를 쓰고, 이미 열린 path면 그 탭과 요청 위치를 재사용한다. 등록 프로젝트 밖의
  image/PDF/binary는 기존 generic preview 규칙을 따른다.
- 워크트리 병합은 별도 결정 대화상자로 두되 "변경 검토 열기"는 결과 탭(작업 폴더 범위)으로 간다.

### 6.5 프로젝트·소프로젝트·실행

> 구현 상태: B3. 옛 기획 자료 처리 **결정 대기(D①-5)**.

- 프로젝트 행은 프로젝트 홈 탭을 연다. 프로젝트 홈은 소프로젝트 목록(주), 작업 폴더·워크트리, 프로젝트 설정
  (루트 폴더 편집), Project Map, 파일 링크, 새 대화를 가진다. 대화 목록은 "대화 N개 →" 링크로만 보인다.
- 소프로젝트 탭은 흐름(캔버스, run bar, 실행 서랍) / 문서(기획·설계·검토) / 기록이다. 실행 시작은 "실행 →
  버전·권한·검토자 확인 → 이 버전으로 실행"의 한 사용자 작업이며, 결과·검토·통합은 같은 탭의 실행 서랍에서
  한다. 개편 전의 두 번째 실행 화면(`PlanningExecutionPanel`)은 없앤다.
- AI 선택(대화, 기획 역할, 단계, 리뷰어, 실행 작업자)은 모두 같은 AI 프로필 picker다. 진행 중 attempt의
  설정 snapshot은 바꾸지 않는다(§22).

### 6.6 원격 켜기

> 구현 상태: B4.

원격 목적지 맨 위에 원격 접속 스위치(설정 → 연동과 같은 설정 키)가 있다. 페어링 카드는 원격이 꺼져 있으면
그 자리에서 켜도록 안내한다. 구형 Android 앱이 새 PC와 프로토콜이 맞지 않으면 양쪽에 "Android 앱 업데이트
필요"와 경로를 보인다.

**결정 대기(D①-9)**: 반대 방향, 즉 새 Android 앱이 구 PC(원격 프로토콜 16 이하)와도 계속 연결되게 할지. 후보는
"연결 유지(역방향 지원)"이며, 그 경우 새 앱은 구 PC에서 새 기능을 숨기고 기존 기능만 쓴다.

## 7. Android 셸

> 구현 상태: I4. 승인된 방향(2026-10-24 Storybook 실물): 첫 화면은 **피드**(나를 기다리는 것 · 흐름 · 대화), 아래
> **묻기 막대**를 누르면 새 대화 화면, 대화 머리줄 한 줄, 승인은 엄지 닿는 큰 버튼, 입력창 칩. 아래 규칙 중 탭 구성은
> I4에서 이 방향으로 확정한다.

공통:

- 탭 이름과 그 화면 제목은 같다(개편 전 "대화" 탭의 제목 "프로젝트" 불일치를 없앤다). 600dp부터 같은 순서의
  72px left rail로 바뀌며 설정을 아래에 둔다.
- **채팅 헤더는 1줄**(← · 제목과 짧은 상태 · ⋯)이다. 정상 상태에서 그 위에 다른 헤더·상태 문장·provider 줄을
  두지 않는다. 연결 장애처럼 필요한 동안만 얇은 상태 띠를 더한다. AI·작업 폴더·권한·스킨·기록·보관·lifecycle
  조작은 ⋯ 시트와 입력창 칩으로 옮긴다. 대화 본문 비율 목표는 [성공 신호](overhaul/success-signals.md).
- 프로젝트 탭은 프로젝트 → 소프로젝트 → **단계 목록과 실행 상태**가 기본이고, 단계의 대화·결과·승인을 같은
  곳에서 연다. 캔버스는 전체 화면으로 열고 확대·이동을 제공하며, 단계 추가·연결·설정은 터치 폼으로도 할 수
  있어 drag에 의존하지 않는다.
- 결과·변경 검토는 대화에서 전체 화면 결과 페이지로 들어가고, 뒤로 가면 같은 메시지·초안·scroll을 복원한다.
- 터미널은 항상 mounted인 TerminalLayer(§7.1)이며 PC 제어는 명시적 Start로 시작하는 immersive 화면이다.
- 앱을 열 때 어디로 갈지의 우선순위는 **결정 대기(D①-11)**: 후보는 (1) 알림으로 열면 그 요청 위치 → (2) 응답이
  필요한 요청이 있으면 확인할 일 → (3) 마지막 작업 복원 → (4) 대화 목록.
- 인증 후 마지막 작업을 복원하고, 복원할 작업이 없으면 첫 화면으로 간다. 인증 host별로 열린 terminal ID,
  활성 terminal/Agent ID와 마지막 작업 화면만 device-local에 저장하고 원문·prompt·credential·draft는 넣지 않는다.
  사라진 세션은 다시 만들지 않으며 저장 실패에도 새 터미널은 쓸 수 있다. 사용자가 이미 이동했으면 늦은 복원이
  화면을 빼앗지 않는다.
- 오프라인에서도 초안은 편집할 수 있지만 승인·전송 성공은 host 확인 뒤에만 표시하며 재연결 자체로 전송하지 않는다.

### 7.1 Persistent terminal layer와 Back

`MobileWorkbenchCoordinator`는 항상 mounted인 TerminalLayer, 현재 page, navigation과 sheet/dialog host를 형제로
구성한다. 터미널이 선택되지 않았을 때 layer는 inert이고 `aria-hidden`이지만 `display:none`이나 unmount를 쓰지
않으며 draft, controller, xterm geometry, scroll, selection, output과 reconnect 상태를 유지한다.

Android Back 순서: (1) top sheet/dialog → (2) 목적지 안 subpage 또는 preview → (3) 전체 화면 목적지에서 invoker/탭
root로 복귀 → (4) root에서 platform delegate. 명시적 close는 history layer를 한 번만 소비하고 ghost entry를 남기지
않는다.

### 7.2 Page와 설정

일반 목적지는 Back, localized title, optional status와 목적지 동작으로 된 하나의 page-header composition을 쓴다.
PC Control만 immersive chrome을 쓴다. 터미널 header는 Back, session sheet와 새 터미널만 둔다. 모바일 설정은
일반, 모양, 터미널·입력, 연동, 연결·정보의 index/subpage 구조다. 기존 setting key와 theme format을 바꾸지
않는다. 일반의 resource profile은 Android 기기에만 저장하고 desktop으로 동기화하지 않으며, desktop과 같은 세
label, 설명과 Low resource 재시작 안내를 쓴다.

### 7.3 Pairing과 연결 상태

연결 화면은 manual URL/token과 QR scanner를 제공한다. 자동 network discovery, 다중 profile, deep link는 없다.

- QR code는 memory-only, single-use이며 5분 후 만료한다.
- 성공하면 Android secure credential store에 장기 token을 저장하고 code를 즉시 폐기한다.
- camera permission은 scanner를 열 때만 요청하며 frame은 기기에서 decode하고 저장·전송하지 않는다. 모든 exit
  path에서 stream을 release한다. camera 거부 또는 미지원 기기는 같은 수동 입력 경로를 쓴다.
- credential loading, connecting, VPN warning, auth rejection, protocol incompatibility(업데이트 필요 안내 포함),
  secure-storage warning과 success는 안정된 geometry와 inline recovery를 유지한다.

### 7.4 Responsive와 safe area

지원 viewport는 360×800, 412×915, 600×960과 915×412다. 모든 touch target은 최소 44×44 CSS px이고 user zoom을
허용한다. document는 가로로 scroll하지 않으며 tab과 accessory strip만 내부 scroll할 수 있다. Safe-area inset은
mobile root가 한 번만 소유한다.

## 8. Command Center와 단축키

> 구현 상태: ②(외형)·B1(대화·프로젝트 색인)·B2(파일). 단축키 **결정 대기(D①-6)**.

- Command Center는 keyboard-first 전역 진입점이며 기존 기능을 검색·이동할 뿐 상태를 복제하지 않는다. 하나의
  maintained implementation만 쓰며 labelled modal, keyboard navigation, active result, focus trap, stale search
  cancellation과 focus restoration을 제공한다.
- 색인: 명령, 프로젝트, 소프로젝트, 대화(기록 포함), 열린 패널(대화 탭 포함), 파일, 설정 페이지, 프리셋, 빠른
  명령, 백그라운드 세션. 목적지 동작은 그 목적지로 정확히 간다(마지막 보기에 따라 다른 화면을 열지 않는다).
  에이전트 CLI 실행 항목은 "터미널에서 실행"으로 라벨을 구분한다.
- `Ctrl/Cmd+K`는 non-editable 앱 UI에서만 열리고 xterm, composer, input, textarea와 contenteditable은 원래 키
  의미를 유지한다. `Ctrl/Cmd+Shift+P`는 전역 alias다. Ctrl+Tab은 최근 패널 전환, Alt+Shift+=/- 는 분할이다.
  **Ctrl+`**(구현 I1)는 메인 창 어디서나(별도 창은 자기 키를 그대로 쓴다) 가장 최근 터미널을 앞으로 가져오고(없으면 새로 만들고, 판이면 작업 모드로), 다시 누르면
  온 곳(직전 탭 또는 판)으로 돌아간다. 터미널 안에서도 앱이 받는다(셸에 Ctrl+`의 의미가 없다).
- 새 단축키 후보(Ctrl+N 새 대화, Ctrl+Shift+` 새 터미널, Ctrl+B 사이드바, Ctrl+P 파일, Ctrl+1…n 레일 목적지)는
  크롬·composer·편집기·PTY별 우선순위와 함께 D①-6에서 정한다. 터미널 안 키 동작은 바꾸지 않는다.
  **결정 대기(D①-6) 제안표** — 칸은 그 맥락에 초점이 있을 때 키를 누가 받는지다.

  | 키 | 앱 크롬(목록·탭·버튼) | 입력창·입력칸(textarea·input) | 문서 편집기 | 터미널(xterm) |
  |---|---|---|---|---|
  | Ctrl+K | Command Center | 양보(지금과 같음) | 편집기 | 셸 |
  | Ctrl+Shift+P | Command Center | Command Center | Command Center | Command Center |
  | Ctrl+N | 새 대화 | 새 대화 | 편집기가 쓰면 편집기, 아니면 새 대화 | 셸(다음 기록) |
  | Ctrl+P | 파일 찾기 | 파일 찾기 | 편집기가 쓰면 편집기, 아니면 파일 찾기 | 셸(이전 기록) |
  | Ctrl+B | 사이드바 | 사이드바 | 편집기가 쓰면 편집기, 아니면 사이드바 | 셸(커서 뒤로) |
  | Ctrl+1…n | 레일 목적지 | 레일 목적지 | 레일 목적지 | 셸 |
  | Ctrl+Shift+` | 새 터미널 | 새 터미널 | 새 터미널 | 새 터미널 |

  원칙: 터미널 안에서는 Ctrl+문자·숫자 단일 조합을 모두 셸로 보내고 앱은 Ctrl+Shift 조합만 가져간다. 입력창과
  입력칸에서 위 Ctrl 키는 지금 편집 의미가 없으므로 앱이 받되, Ctrl+K는 지금처럼 양보한다. 확정되면 이 표가
  `command-center-shortcut.ts`의 맥락 판정과 단축키 테스트의 근거가 된다.

## 9. 개편 진행

- 진행 기록·결정: [`overhaul/README.md`](overhaul/README.md), [`overhaul/approvals.md`](overhaul/approvals.md)
- 기준선과 성공 신호: [`overhaul/journeys-baseline.md`](overhaul/journeys-baseline.md),
  [`overhaul/success-signals.md`](overhaul/success-signals.md)
- 진입점 통합표와 다시 쓸 테스트: [`overhaul/entry-points.md`](overhaul/entry-points.md)
- 시각 비교 기준: [`reference/2.0/manifest.json`](reference/2.0/manifest.json)(승인 화면과 아직 대체되지 않은 1.0
  handoff surface), 상태표 [`reference/README.md`](reference/README.md)

# 2부 · 기능 영역 계약

> 구현 상태: 현행. 지금 제품의 기능 영역 규칙이며 개편 뒤에도 유지가 원칙이다. 1부 목표가 바꾸는 규칙은 그 줄에
> **대체 예정(묶음)**과 목표 절을 함께 적었고, 그 묶음이 구현될 때 이 줄을 목표 내용으로 바꾼다. 대체되는 화면
> 규칙 안에 있던 안전 규칙(검증·재시도·중복 방지·복구)은 대체 뒤에도 유지한다. 각 영역의 출처 줄은 개편 전 원문의
> 절 번호다. 영역 안에서 배치(어느 레일·사이드바·탭에서 여는지)를 말하던 문장은 1부로 옮겼다.

- §10 Design token과 typography
- §11 공유 component와 overlay
- §12 Localization과 접근성
- §13 기능별 주요 상태
- §14 Project·Workspace·Session, 워크트리와 관리 머지
- §15 관리형 Agent tree와 직접 대화
- §16 PC Control
- §17 시각·접근성 검증
- §18 Project 문서 editor와 비교 렌즈
- §19 Explorer 파일·폴더 시각 계층
- §20 Project Map
- §21 채팅의 두 스킨과 입력 공통
- §22 대화 상태·반응형과 AI 실행 정책
- §23 채팅 행·도크·입력창
- §24 대화 결과물
- §25 소프로젝트 흐름 캔버스
- §26 입력 후보·대화 탐색·통합 기록
- §27 UI 작업 공간과 대기열

## 10. Design token과 typography

> 출처: 이전 §6, 이전 §17, R7.1 (원본 보존: docs/ux/reviews/2026-10-23-ux2-baseline/frontend-design.md)

- Token·typography의 사용 판단은 [`DESIGN.md`](../../DESIGN.md), 정확한 role·scale·theme 값은
  [`ui-tokens.css`](../../src/renderer/styles/ui-tokens.css)와 [`themes.ts`](../../src/renderer/themes.ts)가
  소유한다. 이 문서는 값을 다시 열거하지 않는다.
- Application chrome은 semantic `--ui-*` token을 사용한다.
- `--term-*`은 xterm, terminal output과 기존 custom theme 호환에만 쓴다.
- Custom theme의 persisted schema는 바꾸지 않는다.
- Runtime resolver가 semantic role의 contrast와 파생 role을 계산한다.
- Custom theme이 `--term-*`을 생략하면 runtime이 그 theme의 `ui` palette와 xterm 배경으로 채우며, 명시한
  값이 우선한다.
- Feature는 theme별 color, font stack 또는 지역 z-index ladder를 직접 정의하지 않는다.
- 파생 role(hover·selected·status tint·glow·chat surface)은 built-in theme마다 `ui-tokens.css`의 생성
  영역에 고정한다.
- Custom theme의 파생 role은 runtime이 같은 함수 `deriveUiTokens`로 계산한다.
- 공유 foundation, primitive와 채팅 CSS는 Android WebView 74 하한 때문에 `color-mix()`와 `:has()`를 쓰지
  않는다.
- Android로 전달되는 그 밖의 stylesheet에서 `color-mix()`는 같은 블록에 Chrome 74가 읽는 같은 속성의 대체
  선언이 앞설 때만 쓴다.
- [`ui-tokens.test.ts`](../../src/renderer/styles/ui-tokens.test.ts)가 위 두 WebView 하한 규칙을 검사한다.
- Font token은 body, display(wordmark·Matrix heading), heading(기본값은 body), terminal, mono(chat code용,
  terminal font를 따름)로 나눈다.
- 기본 theme 4종과 사용자 theme은 같은 semantic role을 적용한다.
- Theme 적용은 대비, keyboard focus, reduced motion과 작은 화면에서 검증한다.

## 11. 공유 component와 overlay

> 출처: 이전 §7 (원본 보존: docs/ux/reviews/2026-10-23-ux2-baseline/frontend-design.md)

- Button, IconButton, Dialog, ActionSheet, Menu, Popover, Tabs, Toast, Tooltip, FormControls와 Feedback
  primitive는 repository의 공유 [`ui/`](../../src/renderer/ui/) 구현을 쓴다.
- 새 feature는 focus trap, Escape, outside click, disabled, loading, live-region 의미를 다시 구현하지 않는다.
- 한 번에 하나의 modal layer만 top layer로 상호작용하며 background는 inert·`aria-hidden`으로 둔다.
- 안전한 경우 Escape와 Android Back으로 닫을 수 있다.
- 닫으면 stable invoker로 focus를 돌린다.
- 위험 action은 명시적인 label을 쓴다.
- 위험 action의 초기 focus는 안전한 선택지에 둔다.
- Toast는 action의 유일한 오류 설명이 될 수 없다.
- 복구 가능한 오류는 그 오류가 시작된 surface에 남는다.
- loading, empty, offline, permission denied, unsupported, stale data를 같은 skeleton이나 0 값으로 표현하지
  않는다.

## 12. Localization과 접근성

> 출처: 이전 §8 (원본 보존: docs/ux/reviews/2026-10-23-ux2-baseline/frontend-design.md)

- 지원 locale은 한국어와 영어다.
- Effective locale은 desktop menu, renderer와 mobile UI에 하나의 결정 규칙으로 적용한다.
- Provider·protocol·product name은 번역하지 않는다.
- 번역하지 않는 이름도 문장과 accessible label 안에서 자연스럽게 조합한다.
- 하드코딩된 product string은 결함이다.
- 혼합 locale은 결함이다.
- 본문 text 대비는 최소 4.5:1이다.
- Component boundary와 focus indicator의 대비는 최소 3:1이다.
- 의미를 color, glow, animation 또는 icon 하나에만 의존하지 않는다.
- Keyboard focus 순서는 시각 순서를 따른다.
- 모든 action은 visible focus를 가진다.
- Reduced motion에서는 boot, ticker, pulse, rollbar와 장식 transition을 멈춘다.
- Terminal output, remote video와 사용자가 요청한 외부 content는 장식 motion으로 취급하지 않는다.
- Status 변화는 필요할 때 하나의 polite live region으로 알린다.
- fps, cursor, timer tick을 반복해서 announce하지 않는다.
- 200% text zoom과 screen reader label에서도 primary flow를 끝낼 수 있어야 한다.

## 13. 기능별 주요 상태

> 출처: 이전 §9 (원본 보존: docs/ux/reviews/2026-10-23-ux2-baseline/frontend-design.md)

### Boot

- 실제 phase만 표시한다.
- Reduced motion이거나 boot 표시를 끈 preference에서는 즉시 건너뛴다.
- 건너뛰기 입력을 PTY로 흘리지 않는다.
- Timer를 정리한다.

### Monitor

- 마지막 실제 sample과 collection scope를 표시한다.
- Unsupported와 capture 실패를 건강한 0 값으로 만들지 않는다.
- 화면에 보일 때만 수집한다.

### Remote·Pairing

- Bridge off, VPN 없음, service 없음, idle, busy, active를 구분한다.
- QR 만료·사용(redeem)과 device roster에서 오래된 generation을 복원하지 않는다.

### OpenClaw

- 실행 상태와 관리 RPC 연결 상태를 구분한다.
- 시작·중지·재시작과 다음 Windows 로그인 때의 자동 실행 여부를 먼저 보여 준다.
- RPC 연결 실패만으로 채팅 열기를 막지 않는다.
- RPC 연결 실패만으로 정상 실행을 실패로 표시하지 않는다.
- 실제 실행 오류와 재시도 안내는 화면에 남긴다.
- Supervisor 정보, 시도 횟수, 진단 ID·명령 출력·수동 복구 안내는 접힌 실행 상세에 둔다.
- 같은 요청이 진행 중일 때 그 요청만 비활성화한다.
- 충돌하는 중지 요청과 오래된 상태에서의 재시도는 허용한다.
- Chat의 외부 본문은 pixel oracle에서 제외하되 EZTerminal chrome과 상태는 포함한다.

### 붙여넣기 경고·위험한 닫기

- 위험 이유를 유지한다.
- Cancel을 안전한 초기 focus로 둔다.
- 최종 상태 비교가 실패하면 아무것도 실행하지 않는다.

### Explorer

- Root, 빈 folder, repository 아님, Git 사용 불가를 구분한다.
- Breadcrumb, full path, Up과 folder 우선 정렬을 유지한다.

### PC Control

- Unavailable, starting, active, reconnecting, busy, error를 구분한다.
- Input mode, monitor, sticky modifier와 controller 상태는 color 외의 표현도 가진다.

## 14. Project·Workspace·Session, 워크트리와 관리 머지

> 출처: 이전 §10.2, 이전 §10.3, 이전 §10(앞부분) (원본 보존: docs/ux/reviews/2026-10-23-ux2-baseline/frontend-design.md)

### 작업 폴더와 함께 보는 폴더

- 대화의 작업 위치가 primary이고 project의 나머지 등록 폴더가 additional이다(Codex `runtimeWorkspaceRoots`,
  Claude `additionalDirectories`). 대화마다 따로 고르지 않으며 권한 단계는 모든 폴더에 같게 적용된다.
- 워크트리 대화는 그 워크트리를 만든 원본 폴더를 빼서 격리를 지킨다.
- 디스크에 없는 폴더는 AI에 넘기지 않고 `찾을 수 없음 · 이 대화에서 빠짐`으로 보인다.
- AGENTS.md·CLAUDE.md는 작업 위치의 것만 읽는다(Claude는 추가 폴더의 `.claude/` 스킬·명령은 읽는다).
- project 폴더를 바꾸면 진행 중 대화에도 다음 메시지부터 반영하며, Claude는 그 메시지 전에 같은 세션을 다시
  이어 연다.
- 실행 위치는 saved/observed project와 직접 고른 host 폴더를 제공한다. 선택이나 취소만으로 project를 쓰지 않으며
  성공한 direct-directory 실행만 unpinned observed project가 된다.
- Codex/Claude는 primary/additional roots를 받고 generic launcher는 primary만 쓰며, 무시되는 root 수를 실행 전에
  알린다.

### 데이터 맥락

- Project는 저장소와 사용자의 지속적인 작업 맥락이다.
- Workspace는 local checkout 또는 managed worktree다.
- Session은 Agent, Terminal, Diff/Review, opt-in Browser, Script/Service 탭을 소유한다.
- 기존 독립 terminal은 호환되는 Local workspace 아래에 비파괴적으로 등록한다.
- 별도의 `협업 설정` 목적지, Project별 협업 enable/profile/path/limit form과 별도 run graph를 만들지 않는다.
 

### 워크트리 생성

- 워크트리는 Desktop에서만 만든다.
- 브랜치 이름을 받아 project checkout 옆에 worktree를 만든다.
- 커밋되지 않은 변경은 새 worktree로 옮기지 않는다.
- 만든 뒤 그 위치의 새 대화를 연다.

### 워크트리 상태

- 상태는 git에서 읽는다. 그 위치의 대화가 실행 중이면 `작업 중`, 아니면 base보다 앞선 커밋이나 커밋되지 않은
  변경이 있을 때 `검토 대기`, base에 병합됐으면 `완료`다.
- 워크트리 목록이나 그 안의 실행 여부가 바뀔 때와 창이 focus를 얻을 때 상태를 다시 읽는다.

### 병합

- 병합 대화상자는 보낼 커밋 수와 미커밋 변경 여부를 보인다.
- 미커밋 변경이 있으면 먼저 커밋 메시지를 받아 커밋한 뒤 base branch에 병합 커밋 하나로 합친다.
- 충돌이면 병합을 되돌리고 이유를 보인다.

### 워크트리 정리

- 병합됐고 깨끗하면(앞선 커밋 0, 미커밋 없음) 같은 대화상자가 `워크트리 정리…`를 보인다.
- 정리 확인 단계는 danger tone이고 초기 focus는 `돌아가기`다.
- 확인 단계는 폴더 삭제, 브랜치 삭제(병합된 base와 함께), 이 위치 대화 N개 보관(기록은 남고 이어 갈 수
  없음)과 `되돌릴 수 없습니다`를 보인다.
- 이 위치에 진행·대기 중인 turn, 승인 대기, 실행 중인 터미널·스크립트가 있으면 이유와 함께 `정리`를 막는다.
- Main은 git 상태와 바쁨을 다시 확인하고, 대화를 보관해 provider 프로세스를 내린 뒤, 폴더를 force 없이
  지우고 병합된 브랜치를 지운다.
- 폴더를 잡은 프로그램이 있으면 아무것도 지우지 않고 거부한다.
- 성공하면 대화상자가 닫히고 해당 행이 사라진다.
- 브랜치를 남겼으면 그 이유를 보인다.

### 실행 중 Agent 표시와 수명 action

- 모든 실행 중 Agent 행·카드는 provider, model, permission preset, workspace와 현재
  `starting/working/blocked/done/idle/error/unknown` 상태를 함께 표시한다.
- Cancel(현재 turn 중단), Archive(실행을 종료한 뒤 기본 목록에서 숨김), Detach(parent edge만 제거하고 최상위
  session으로 승격)는 서로 다른 action이며, Agent의 현재 turn 중단과 종료·보관을 하나로 합치지 않는다.

### 목록의 실행 상태

- 일반 Terminal과 Agent는 같은 daemon identity로 보여 준다.
- CLI가 실행 중인 Terminal은 감지된 provider와 상태를 표시한다.
- 저장된 PTY 기록만으로 실행 중이라고 간주하지 않고 live session 목록과 대조한다.
- 종료된 Terminal은 재접속 대신 `같은 위치에서 새 터미널`을 제공한다.

### 보기 닫기, 재연결과 종료

- Session 탭의 `×`/`화면 닫기`와 auxiliary window 닫기는 layout(보기)만 바꾸며 실행과 history를 종료하지
  않는다.
- 같은 session을 다시 열면 완료된 block을 포함한 기존 output을 재연결하고 process-local draft, scroll, 사용자
  탭 이름과 project identity를 복원한다.
- 명시적 view detach는 crash 복구 유예와 구별하며, 화면이 없어도 host 작업은 계속 실행된다.
- 기존 SSH late-attach 제한은 유지한다.
- Agent follow-up draft와 transcript scroll은 session별로 유지하며 Android 연결 사이에 공유하지 않는다.
- 이 presentation state는 일반 layout이나 plaintext storage에 저장하지 않는다.
- Terminal의 `세션 종료`는 별도 action이다. Cancel 초기 focus와 실행 중 작업 수를 보여 준 뒤 최신 run set을
  확인하고 guarded termination한다.
- 관찰이 실패하거나 상태가 바뀌었으면 종료하지 않는다.
- 앱 메인 창의 quit·tray 정책은 이 action들 때문에 바뀌지 않는다.

### 관리 merge

- Merge queue 카드 하나에서 source→target, Agent alias, immutable request revision, validation 상태와
  warning/error를 읽을 수 있어야 한다.
- Candidate review는 정확한 target/candidate pair를 연다.
- Revision이 stale이면 diff와 승인 action을 계속 쓰지 않는다.
- 정상 validation에는 Approve/Deny를 제공한다.
- 실패한 validation의 Override는 desktop 전용이며 이유 입력과 두 단계 확인을 요구한다.
- `다음 1회 자동 머지`는 participant, workspace, target과 만료 시간을 먼저 보여 주며 영구 설정처럼 표현하지
  않는다.
- Merge button은 raw terminal Git 명령을 보내지 않고 main의 관리 merge operation만 호출한다.
- Preparing/validating/merging 중에는 중복 action을 막고 현재 단계 label을 유지한다.
- 성공, deny, conflict, stale, failed, interrupted는 서로 다른 text 상태이며 color만으로 구분하지 않는다.
- 상세 process·보안 계약은 [`agent-collaboration.md`](../design/agent-collaboration.md)가 소유한다.

### Android의 Agent 기능

- Android는 같은 daemon snapshot에서 Agent status, live transcript, 직접 대화, approval, stop, archive와
  detach를 제공한다.
- Provider 설치, browser host, validation override처럼 Desktop host에서만 가능한 action은 이유와 복구 위치를
  설명하며 가짜 control을 만들지 않는다.
- Mobile merge card도 source→target, validation 결과와 "request가 바뀌면 action이 실패할 수 있다"는 revision
  의미를 유지한다.

### Android Agent 생성

> 현행: Android 복구·구 host 경로의 `Agent 만들기`(빈 세션을 먼저 만들고 첫 메시지를 따로 보냄).
> **대체 예정(B1)**: 1부 §6.1처럼 첫 전송이 대화를 만든다. 아래 snapshot 검증, idempotency 재조회, revision
> 재시도, 중복 금지, 이전 복구 명령 표시 규칙은 대체 뒤에도 유지한다.

- Agent draft는 선택만으로 어떤 entity나 terminal surface도 만들지 않는다.
- `Agent 만들기`는 최신 daemon snapshot으로 active Project·Workspace와 ready provider를 검증한 뒤 첫 prompt
  없는 `agent.create`를 제출한다.
- 성공 receipt 뒤 빈 idle 세션을 즉시 열고, 같은 session id의 authoritative snapshot이 이를 대체한다.
- 첫 메시지는 별도 `agent.submit`으로 보낸다.
- 이전 버전의 prompt 포함 생성 명령은 복구와 자동화를 위해 계속 지원한다.
- Revision conflict는 같은 논리 session id와 title을 유지한 채 제한된 횟수만 새 command id로 재시도한다.
- 생성 결과를 확인할 수 없으면 provider, model, permission, Workspace를 잠그고 같은 idempotency command를
  먼저 조회·재전송한다.
- 이전 복구 명령에 prompt가 있으면 읽기 전용으로 표시한다.
- 다른 초안이나 중복 세션을 자동으로 만들지 않는다.

### Android 생성 복구 기록

- 각 `agent.create`를 보내기 전에 exact command를 Keystore 기반 secure storage에 기록하고 read-back까지
  확인한다.
- 앱 프로세스가 다시 시작되면 이 한 건을 잠긴 draft로 복원하고, 최신 daemon snapshot에서 기존 session을 먼저
  대조한다.
- Secure storage가 loading 또는 unavailable이면 Agent 생성만 비활성화하고 이유와 `Retry`를 제공하며, Terminal
  선택과 생성은 유지한다.
- 복구 레코드와 secure key는 현재 인증 bearer의 SHA-256 fingerprint에 결속하며, 다른 Desktop의 미확정
  command를 현재 연결에 노출하거나 재전송하지 않는다.
- Raw bearer, prompt, command의 plaintext·localStorage fallback을 두지 않는다.
- 레코드가 유효하지 않으면 일반 unavailable과 구분해 설명한다.
- `복구 기록 폐기`는 이전 command가 이미 도달했다면 중복될 수 있음을 알리는 alert dialog와 안전한 Cancel
  초기 focus를 거친다.
- 해독할 수 없는 현재 authority 레코드도 같은 확인을 거친 뒤 해당 raw secure-storage key만 제거할 수 있어야
  한다.
- Draft가 이미 열린 뒤 유효한 복구 레코드의 loading이 끝나면, 다시 열도록 요구하지 않고 같은 화면에서 exact
  provider·model·permission·Project·Workspace·prompt를 동기화해 잠근다.

### Desktop 생성 복구 경계

- Desktop은 같은 경계에서 main process의 memory-only renderer checkpoint 저장 완료를 기다린다.
- 미확정 생성이 있는 tab·window·layout 교체를 우발적으로 닫지 않는다.
- Keep-running 창 닫기는 process와 checkpoint를 유지한 채 숨긴다.
- Quit-on-close는 복구 경로를 잃으므로 차단한다.
- 명시적 Quit은 Cancel을 기본값으로 두고 복구 정보 폐기와 중복 생성 위험을 추가로 설명한다.
- 첫 prompt는 durable Dockview layout에 직렬화하지 않는다.

### Android Terminal 생성과 Back

- Terminal 생성은 provider 상태와 무관하지만, 선택한 Workspace의 최신 active 상태와 rootPath를 host에서 다시
  검증한 뒤 기존 mobile terminal surface 생성 경로를 쓴다.
- Provider 설치와 Claude 요구 사항 동의는 Desktop에서만 하며, mobile draft는 그 복구 위치를 설명한다.
- Full-screen draft와 생성된 Agent session은 공통 mobile history layer를 써서 UI Back, browser Back, Android
  Back이 한 단계만 닫는다.
- 닫은 뒤 focus는 draft를 연 invoker로 돌아간다.

## 15. 관리형 Agent tree와 직접 대화

> 출처: 이전 §10.3 (원본 보존: docs/ux/reviews/2026-10-23-ux2-baseline/frontend-design.md)

### 협업 설정과 프로필

- `에이전트가 다른 에이전트를 만들 수 있음`은 기본 꺼짐이며, 켜면 이후 새로 만들거나 resume하는 모든 Agent
  session에 session-scoped orchestration MCP를 연결한다.
- 에이전트 프로필은 새 대화의 `프로필` 선택(AI·모델·권한·강도를 채움)과 맡기기가 함께 쓴다.

### Provider-native subagent

- Provider-native subagent도 관리형 child와 같은 track에 표시하되 provider-owned·read-only임을 명확히
  구분한다.
- Native subagent를 열면 받은 지시·도구·결과만 보이며, 입력창 대신 `상위 대화에서 이어집니다`와
  `← 상위 대화` breadcrumb를 둔다.
- Parent의 Agent/Task 도구 행에는 `열기`를 붙인다.

### 맡기기

- `맡기기`·`검토 맡기기` 대화상자는 프로필, 작업 위치(새 워크트리 포함), 미리 채운 지시와
  `끝나면 결과를 이 대화로 보내기`(검토 맡기기는 기본 켬, 맡기기는 기본 끔)를 받는다.
- 맡긴 뒤 사용자는 parent에 남고 child는 track과 트리에 나타난다.
- 회신된 결과는 parent에 `서브에이전트가 보낸 결과 · 제목 · 열기`로 보인다.

### Child track

- Agent transcript와 composer 사이에 direct child를 보여 주는 compact track을 둔다.
- Child가 없으면 track을 렌더링하지 않는다.
- Track은 작업 중·확인 대기 항목을 앞에 두고 4개까지 보인 뒤 `외 N개`로 접는다.
- 항목은 provider, 상태, 경과 시간, attention과 bounded result summary를 보여 준다.
- 항목 click은 같은 child Agent 탭을 열거나 재사용한다.
- 같은 Workspace의 child는 탭을 자동으로 열지 않으며, cross-workspace child만 새 작업 맥락을 알리기 위해
  자동으로 열 수 있다.
- Parent에는 child transcript를 복사하지 않고 bounded summary event와 session link만 전달한다.

### 관리형 child 대화

- 관리형 child는 parent와 같은 완전한 Agent session이다.
- 사용자는 child 대화에서 직접 prompt를 보내고 model과 permission preset을 바꾸며 Interrupt+Send, Cancel,
  Archive, Detach를 쓸 수 있다.
- Busy session의 일반 Send는 FIFO 대기열에 들어가고 Interrupt+Send만 현재 turn을 중단한다.
- Tree는 재귀와 cross-provider를 지원한다.
- Host hard cap인 동시 managed turn 4, tree node 16, depth 4, tree당 10분 안의 child 생성 12를 숨기지 않는다.
- Turn과 Lead 위임 사이클에는 경과 시간 제한이 없다.
- 동시성 cap 초과는 queue에 넣고, 다른 cap 초과는 구조화된 오류로 거부한다.

### 쓰기 child와 merge

- Write Agent는 전용 managed worktree를 쓸 수 있다.
- Write child는 diff/review를 제공하고, merge는 명시적 action으로만 하며 §14의 관리 merge 흐름을 쓴다.
- Runnable writer의 scope 충돌, stale source revision, validation 실패를 자동 merge로 우회하지 않는다.

### 검증과 소유권

- Production Storybook은 draft, active/queued/attention, direct child 대화, native subagent,
  archived/detached와 permission 상태를 실제 component adapter로 검증한다.
- 실행·저장·권한의 상세 계약은 [`agent-collaboration.md`](../design/agent-collaboration.md)가 소유한다.

## 16. PC Control

> 출처: 이전 §11 (원본 보존: docs/ux/reviews/2026-10-23-ux2-baseline/frontend-design.md)

### 시작과 session handle

- Mobile PC Control은 명시적 Start 뒤에만 video와 input을 연다.
- Active 화면에는 video를 가리는 상시 toolbar를 두지 않는다.
- 화면 가장자리에 최소 touch target을 만족하는 session handle을 항상 남긴다.
- Handle은 세로로 이동하고 좌우 edge에 붙으며 위치를 기기에 저장한다.
- Handle은 active와 reconnecting을 color뿐 아니라 shape와 accessible name으로 구분한다.

### Session sheet

- Handle은 하나의 session ActionSheet를 연다.
- Sheet 순서는 input mode, view/monitor, quality, keyboard·clipboard tools, 접힌 connection details,
  Disconnect다.
- 기본 input mode는 Precision pointer다.
- Direct touch는 host capability가 있을 때만 활성화한다.
- Fit은 zoom과 pan을 모두 초기화한다.
- Quality는 Balanced, Clarity, Responsiveness를 제공한다.
- Quality를 지원하지 않는 구형 host에서는 update 필요 상태를 정직하게 표시한다.
- Connection details에는 stream 크기, fps/latency, loss, bitrate, decoder drop과 실제 capture/encoder
  backend만 표시한다.

### Touch와 pointer 입력

- Precision pointer에서 한 손가락 이동은 cursor, tap/double tap은 click/double click, double-tap 후 drag와
  long-press drag는 button hold다.
- 두 손가락은 pan/pinch zoom, 두 손가락 double tap은 2×와 Fit 전환, 세 손가락 이동은 wheel이다.
- Direct touch는 remote absolute 좌표를 쓴다.
- OS에 이미 연결된 Bluetooth mouse는 별도 설정 없이 active video surface의 hover, left/right/middle button,
  drag, 가로·세로 wheel을 같은 input contract로 보낸다.
- Mouse 이동은 Precision pointer에서 상대 이동, Direct touch에서 절대 좌표다.
- Pointer cancel, focus 이탈, reconnect, background, mode 변경과 close에서는 눌린 button·key·modifier를 먼저
  release한다.

### Zoom과 ROI

- Zoom과 pan은 local transform으로 즉시 반응하고 안정된 viewport를 host ROI로 보낸다.
- Host가 적용한 revision과 source region을 확인하기 전에는 zoom 상태의 Direct touch 입력을 잠시 막아 영상과
  absolute 좌표가 어긋나지 않게 한다.
- Adaptive-region capability가 없는 host에는 기존 full-frame viewport만 보내며 local Fit·입력 계약은 유지한다.

### Keyboard, clipboard, Back과 background

- Keyboard action은 IME input과 가로 scroll 가능한 accessory를 열고 Ctrl/Alt/Shift/Win sticky 상태,
  Escape/Tab/Enter/Delete/arrow와 F1–F12를 gesture 없이 제공한다.
- Clipboard는 자동 동기화하지 않고 명시적 Send/Copy만 쓴다.
- Android Back은 sheet, keyboard, remote page 순서로 닫는다.
- Background로 전환되면 input과 session을 정리하고 자동 재개하지 않으며, 사용자가 Resume을 고른다.

### 물리 keyboard

- OS에 이미 연결된 Bluetooth keyboard는 별도 toggle 없이, session이 active가 되면 video surface가 focus를
  받아 문자·숫자·기호, modifier 조합, navigation/edit와 F1–F12의 물리 key transition을 remote layout/IME로
  보낸다.
- Android가 소비하는 system key와 host가 지원하지 않는 key는 가로채지 않는다.
- Video surface 밖의 session handle, ActionSheet, keyboard accessory, reconnect/close UI와 background에서는
  물리 key나 mouse event를 remote input으로 보내지 않는다.
- Sheet를 닫으면 active video surface로 focus를 복구한다.
- 물리 입력 지원은 기존 touch gesture와 명시적으로 여는 IME input을 대체하지 않는다.

### Desktop 표시

- Desktop banner와 tray 표시는 active controller가 있을 때만 나타나며 device와 local Disconnect를 제공한다.
- Controller가 시작될 때 terminal focus를 훔치지 않는다.
- Release 뒤 즉시 사라진다.
- Native 오류 remediation은 원격 관리 화면에 남기고 stale active banner를 유지하지 않는다.

### 검증

- Production Storybook은 Ready, Active handle, 열린 Session sheet, Keyboard accessory, Reconnecting과
  Unavailable을 deterministic adapter로 포함한다.

## 17. 시각·접근성 검증

> 출처: 이전 §12, 이전 §10.3, 이전 §11, 이전 §15, 이전 §17, R7.1 (원본 보존: docs/ux/reviews/2026-10-23-ux2-baseline/frontend-design.md)

- 시각 합격 기준은 [`DESIGN.md`](../../DESIGN.md), 화면·상태·responsive 합격 기준은 이 문서가 소유한다.
- 두 문서의 내용을 snapshot 설명에 복사하지 않는다.
- 시안 데이터, 가짜 AI 응답, 자동 캡처는 실제 provider·PTY·Android 복구 검증으로 인정하지 않는다. 그런 검증은
  실제 앱(격리 프로필)과 실제 기기·에뮬레이터에서 따로 남긴다.
- 시각 비교 기준 화면은 [2.0 reference manifest](reference/2.0/manifest.json)가 고정한다. 승인된 2.0 화면은
  production story·visual snapshot·실앱 capture를, 아직 대체되지 않은 1.0 surface(`legacy` 목록)는
  [`DesktopHandoff.stories.tsx`](../../src/renderer/workbench/DesktopHandoff.stories.tsx)의 실제 product
  component와 deterministic adapter를 쓴다.
- 각 기준 화면 story(1.0 legacy와 2.0 승인 모두)는 axe 검사와 1920 reference를 가진다.
- 기준 화면 story는 한국어·영어 product content를 검증한다.
- Pairwise visual matrix는 800×600/1024×720 overlay와 1200×800/1440×900 reflow를 포함한다.
- Pairwise visual matrix는 100%/150% scale의 shell, sidebar와 dialog를 포함한다.
- Pairwise visual matrix는 Matrix, Light, Dark, High Contrast를 포함한다.
- Pairwise visual matrix는 reduced motion의 boot, ticker, pulse, rollbar와 transition을 포함한다.
- Pairwise visual matrix는 mobile 360×800, 412×915, 600×960과 landscape 핵심 화면을 포함한다.
- Snapshot은 실제 reference와 나란히(side-by-side) 검토한 뒤에만 accepted baseline으로 갱신한다.
- Adaptive layout, external content, 보안 또는 truthful-data 차이만 manifest 예외로 기록한다.
- 문서 정리만을 이유로 snapshot을 갱신하지 않는다.
- 앞선 고정 시안(보관된 1.0 desktop handoff 원본 포함)은 수정하거나 덮어쓰지 않고 snapshot 대상으로 쓰지
  않으며, mobile 계약을 포함한 기능 계약 변경의 갱신 대상도 아니다.

## 18. Project 문서 editor와 비교 렌즈

> 출처: 이전 §13.4–이전 §13.11 (원본 보존: docs/ux/reviews/2026-10-23-ux2-baseline/frontend-design.md)

> 배치: 현행은 Project Explorer가 프로젝트 사이드바를 대신하는 구조다. **대체 예정(B2)**: 1부 §5의 파일 목적지와
> 파일 탭으로 옮기며, 아래 문서 정체성·비교 렌즈·tree·editor·상태·lifecycle 규칙은 파일 탭에 그대로 적용한다.
> 개편은 편집 기능을 추가하지 않는다(기능 유지 범위).

### 범위

- Project 문서 surface는 read-only 탐색이다. 편집·저장, LSP, stage, revert, commit과 모바일 구현은 범위 밖이다.
- 이미 열린 path는 새 tab을 만들지 않고 그 tab과 요청 위치를 재사용하며, preview tab·double-click pinning·
  Keep Open은 두지 않는다.
 

### 문서 정체성

- 문서의 durable identity는 `projectId + rootId + workspaceId + canonical project-relative path`다.
- Windows path 대소문자는 main process가 canonical equality key로 정규화한다.
- Repository, revision, comparison source, reveal 위치와 view mode는 tab identity가 아니며 layout에 저장하지
  않는다.

### 비교 렌즈

- 기본 렌즈는 `HEAD ↔ 현재 checkout` 전체 변경이다.
- 직접 파일 열기와 tree 재선택은 항상 기본 렌즈로 돌아간다.
- Agent Session 링크만 exact `historyId + turnId` 렌즈를 같은 tab에 일시 적용하고, 닫을 수 있는 `Agent turn`
  provenance chip을 보인다.
- Chip을 닫으면 현재 변경 렌즈로 돌아간다.
- Staged/branch/commit catalog와 selector는 제공하지 않는다.

### Tree의 Git 표현

- Tree는 실제 entry와 Git 상태를 합쳐 같은 node에 `M/A/D/R`과 `+N -M`을 표시한다.
- 삭제된 path와 rename의 이전 path는 virtual node로 나타낸다.
- Nested repository, untracked 파일, 첫 commit 이전 repository에서도 정확한 상태를 계산한다.
- 색만으로 상태를 구분하지 않는다.

### Editor와 inline diff

- 파일 surface는 하나의 `project-editor`다.
- 1 MiB 이하 text 파일은 첫 줄부터 마지막 줄까지 자르거나 unchanged region을 접지 않고 표시한다.
- 변경된 파일은 같은 Monaco surface에서 inline diff를 자동으로 표시한다.
- 전체 파일 보기, 현재 파일 보기, 미리보기 같은 전환 button을 두지 않는다.
- Toolbar는 breadcrumb, 선택적 Agent-turn provenance, read-only 상태, Find, Go to Line, 이전/다음 변경과
  Refresh만 포함한다.
- Ask about code, Add lines, Add with snippet, question composer와 reference 수집·전송 control은 두지 않는다.
- Provider의 안전한 before model을 만들 수 없으면 현재 파일 전체를 유지하고 검증된 record를 같은 surface의
  view zone에 표시한다.
- 현재 파일도 없으면 같은 path tab에서 record-only 또는 deleted 상태를 정직하게 표시한다.
- 과거 내용을 현재 파일인 것처럼 추정하지 않는다.

### Wide와 narrow

- Breakpoint는 `1024 CSS px`이다. 이상은 wide, 미만은 narrow다.
- Wide에서 파일 tree 폭은 280–400px다.
- Wide에서 editor는 available height의 68%, 그 아래 PTY/Agent 영역은 32%가 기본이며 비율은 resizable이다.
- 기존 여러 PTY group의 topology와 panel instance를 유지한다.
- File open과 layout 변경은 terminal focus를 빼앗지 않는다.
- 사용자가 editor tab을 명시적으로 활성화할 때만 editor에 focus를 준다.
- Narrow에서 파일 tree는 필요할 때 여는 focus-trapped drawer이며 파일을 활성화하면 자동으로 닫힌다.
- Narrow에서 editor와 PTY는 Dockview tab으로 전환하고 PTY renderer는 계속 mounted 상태를 유지한다.
- Narrow에서 활성 surface(editor 또는 PTY/Agent)는 본문 높이 전체를 채운다.
- Breakpoint 왕복과 project 종료 시 panel node를 재생성하지 않고 원래 group membership과 크기를 복원한다.
- 파일 tree를 담은 sidebar·drawer를 닫았다 다시 열어도 active project, 펼친 folder, selection과 search
  query를 유지한다.

### 작업 위치와 권한

- Project에 실제 checkout이 하나면 작업 위치 selector를 숨긴다.
- Main checkout 또는 EZTerminal managed worktree는 즉시 읽을 수 있다.
- 외부 worktree는 exact canonical path, branch와 Git identity를 보여 준 뒤 사용자 승인을 받아 read-only로
  연다.
- PTY나 Agent 링크가 작업 위치를 조용히 전환하지 않는다.
- 승인 취소, 경로·repository identity 변경 또는 project 제거 뒤에는 저장된 승인을 재사용하지 않는다.

### 상태

모든 상태는 같은 workspace 안에서 표현한다.

| 상태 | 표현 |
| --- | --- |
| loading/long-running | tree 또는 editor 영역에 `aria-busy`, 기존 내용 유지, stale request 취소 |
| empty project/folder/search | 대상과 다음 행동을 구체적으로 설명하며 가짜 file을 만들지 않음 |
| unchanged text | 전체 read-only file, diff decoration 없음 |
| M/A/D/R | 전체 문맥 inline diff 또는 검증된 deleted/record-only 상태 |
| binary·1 MiB 초과 | 같은 path tab의 명시적 unavailable 상태, 일부 내용 미리보기 없음 |
| permission/external worktree | main이 검증한 승인 surface, 취소 가능 |
| stale/missing | 현재 revision과의 불일치를 설명하고 안전한 Refresh 제공 |
| comparison failure | 읽을 수 있는 현재 파일 유지, provenance 가까이에 retry 가능한 warning |
| offline | 모든 source가 local-only라 not applicable, network fetch를 시작하지 않음 |
| validation | 편집·저장이 범위 밖이라 not applicable |
| success | tree selection, tab, breadcrumb와 comparison lens가 같은 path를 표시 |

### Component와 입력

- 기존 Monaco, lucide-react, project token, button, input, tree와 SidebarShell primitive를 재사용한다.
- 새 dependency, font, image asset, network resource나 telemetry를 추가하지 않는다.
- Component taxonomy는 App 소유 project state, Project Explorer tree/search, document open coordinator,
  `project-editor`, comparison provenance, worktree approval, layout coordinator로 제한한다.
- Tree는 roving focus, Arrow/Home/End, Enter/Space를 지원한다.
- Search result는 line/column까지 editor에 전달한다.
- Breadcrumb와 긴 path는 줄임표와 전체 accessible name을 함께 제공한다.
- 모든 icon-only control에는 label과 tooltip이 있다.
- Focus-visible outline을 유지한다.
- `M/A/D/R`과 증감 수치는 visible text와 screen-reader name 모두에 포함한다.
- 접근성 목표는 WCAG 2.1 A/AA다.
- Keyboard-only, screen reader label, contrast, focus order와 reduced motion을 관찰 가능한 방식으로 검증한다.

### Lifecycle 불변 조건

- Project 진입, 파일 열기, wide/narrow 전환, sidebar 열기·닫기와 project 종료 동안 PTY process, session id,
  output, 실행 중 command, input draft, selection, scroll, active panel과 focus를 잃지 않는다.
- Layout coordinator는 기존 Dockview node를 이동하며 `fromJSON`이나 panel 재생성을 쓰지 않는다.
- Project editor의 저장 descriptor에는 identity만 남기고 content, revision, lens, reveal, preview 상태는
  저장하지 않는다.
- Legacy pinned `code-file`/`code-diff` descriptor는 같은 path의 `project-editor`로 migration한다.
- Legacy preview는 복원하지 않는다.

### 시각 QA와 증거

- Normative mock이나 외부 design file은 없으며 이 문서와 실제 Storybook story가 규범이다.
- Story가 계약과 달라져도 문서를 자동으로 story에 맞추지 않는다.
- Asset은 기존 repository 소유 icon·token만 쓰며 추가 license 검토 대상은 없다.
- Storybook 통합 story는 `tree + full-file inline editor + live PTY`를 1440×900 wide와 800×600 narrow에서
  보인다.
- Loading, empty, `M/A/D/R`, deleted, record-only, permission과 error 상태를 component test와 story에서
  검증한다.
- Project-local visual snapshot은 available height 채움, 상하단·수평 clipping 부재, drawer 전환과 별도
  Changes·질문 UI 부재를 확인한다.
- Electron E2E는 tree·search·PTY·Agent 진입의 same-tab 재사용, exact reveal, breakpoint 왕복과 PTY lifecycle
  불변 조건을 실제 runtime에서 확인한다.
- Gate는 lint, typecheck, unit/component test, Storybook/visual과 ordinary `pnpm e2e`다.
- Release performance benchmark는 이 영역의 검증 lane이 아니다.
- Filesystem·Git 한계는 기능을 추정하거나 새 Source Control UI를 추가하는 근거가 아니며, 같은 path의 명시적
  unavailable 상태로 처리한다.

## 19. Explorer 파일·폴더 시각 계층

> 출처: 이전 §14 (원본 보존: docs/ux/reviews/2026-10-23-ux2-baseline/frontend-design.md)

- 이 규칙은 desktop의 일반 Files Explorer와 Project Explorer가 공유하는 entry 표현 계약이며, 큰 폴더에서
  별도 학습이나 view 전환 없이 폴더·파일 종류·계층을 즉시 구분하게 한다.
- Quick Open, editor tab, breadcrumb와 mobile surface는 이 계약의 범위가 아니다.
- Icon은 Lucide, 색은 semantic `--ui-*` token만 쓴다.
- File-icon package 같은 새 dependency, image, font, network asset, telemetry 또는 persisted theme role을
  추가하지 않는다.
- Folder는 `Folder`와 `FolderOpen`, 낮은 opacity의 fill, 절제된 accent와 굵기 650의 이름을 쓴다.
- Project tree의 펼친 folder는 옅은 surface와 16px 간격의 semantic border indentation guide를 가진다.
- File 종류는 대소문자를 구분하지 않는 basename과 extension으로 판별한다.
- README/CHANGELOG/LICENSE, package manifest, lockfile, Docker/Make/Git/editor/env/config 파일은 extension보다
  먼저 판별한다.
- `test`/`spec` 이름은 일반 code extension보다 먼저 판별한다.
- Icon shape은 code, web/style, terminal script, JSON, config, document, test, data, image, archive와 generic
  fallback을 구분한다.
- 색 category는 folder/accent, code/info, config/warning, document/subdued-info, test/success, media와
  generic/muted로 제한한다.
- Danger 색은 Git delete/conflict 전용으로 남긴다.
- Project tree의 28px row, 일반 Explorer의 compact padding, selection background, focus outline, Git
  `M/A/D/R`와 diffstat를 유지한다.
- Selection과 Git status는 file-type 색보다 강한 signal이어야 한다.
- Icon은 장식이며 `aria-hidden`이다.
- Project tree folder는 `aria-expanded`로, 일반 Files list는 localized visually-hidden file/folder text로
  종류를 전달한다.
- 의미는 색 하나에 의존하지 않는다.
- Create/rename, loading, empty, error와 parent entry에서도 기존 keyboard·pointer 동작을 유지한다.
- 외부 normative mock은 없으며 `ProjectWorkspaceComposition`의 wide/narrow story와 `DesktopHandoff` Explorer
  story가 visual oracle이다.
- Visual oracle은 대표 folder/code/config/document/test/media/generic entry와 High Contrast를 포함한다.
- 검증 gate는 resolver unit test, 두 Explorer의 component test, Storybook axe/visual, lint, typecheck와
  ordinary `pnpm e2e`다.
- Release performance benchmark는 이 영역의 검증 lane이 아니다.

## 20. Project Map

> 출처: 이전 §15 (원본 보존: docs/ux/reviews/2026-10-23-ux2-baseline/frontend-design.md)

### Surface

- Project Map은 desktop 전용 Dockview 패널이며 사용자가 명시적으로 열 때만 열린다.
- 기존 Project 문서·PTY·Agent 패널을 대체하지 않는다.
- Collection 하나당 하나의 패널을 재사용한다.
- 패널은 renderer에서 native React/SVG로 그린다.
- 외부 HTML, WebContentsView, repository가 제공한 CSS나 실행 가능한 내용을 렌더링하지 않는다.
- 저장·검증·provenance 계약과 mode 의미는 [`project-map.md`](../design/project-map.md)가 소유한다.

### 정보 순서와 panel header

- 정보 순서는 map 선택과 검증·승인 상태, 검색·chapter, diagram, 선택한 항목의 근거, 검증 check, Agent
  authoring이다.
- Panel header에는 map selector, candidate가 있을 때의 **맵 승인**, 승인 뒤에만 활성화되는 theme/export와
  refresh를 둔다.
- Candidate, last-approved, background verification은 diagram을 가리지 않는 inline banner로 구분한다.
- Stable-ID semantic/evidence diff는 접힌 summary에서 수량을 먼저 보이고 필요할 때 펼친다.

### 검증 상태

- `binding-required`에서는 diagram 대신 logical root별 workspace 선택과 명시적 Save를 먼저 보인다.
- `stale`은 현재 source가 review를 요구함을 알린다.
- Invalid current source는 raw 결과를 그리지 않는다.
- 기존 승인이 있으면 last-approved를 계속 탐색하게 하고, 없으면 원인과 recovery가 있는 invalid 상태를 보인다.
- Loading은 최초 검증과 approved cache 뒤의 background 검증을 구분하며, background 검증은 기존 map interaction을
  막지 않는다.

### 생성·갱신 요청

- 생성·갱신 요청마다 전용 Agent session을 연다. 기존 active Agent의 현재 turn 뒤에 queue하거나 보이지 않는
  background worker를 main에서 만들지 않는다.
- 전용 session은 프로젝트의 검증된 `새 세션` 준비·실행 경로를 재사용하고 정확한 Project/root/workspace를
  고정한다.
- Manifest가 없는 empty state의 primary action은 **Project Map 만들기**다.
- 별도 modal 없이 같은 panel에서 첫 map type, 설치된 Codex/Claude Agent와 편집 가능한 creation brief를 순서대로
  보인다.
- Active Agent 유무와 coordination join 여부는 생성 가능 조건이 아니다.
- 설치된 지원 Agent가 없으면 Agent 설정에서 복구할 수 있음을 표시하고 실행을 비활성화한다.
- Create/Update를 누르면 main이 선택한 Agent와 exact owning workspace를 다시 준비한 뒤 새 project terminal 탭을
  열고 focus한다.
- 이 탭은 일반 `새 세션`과 같은 실제 Agent PTY이며, Project Map 전용 요청이라는 사실과 이후 출력·승인·오류를
  사용자가 직접 볼 수 있어야 한다.
- 새 PTY의 Agent activity가 식별된 뒤에만 그 activity를 소유자로 하는 tracked job을 저장한다.
- 같은 runtime-only bootstrap이 반환된 job ID를 brief에 결합하고 PTY의 bracketed-paste ready 신호에 맞춰 최초
  prompt를 한 번 제출한다.
- 기존 Agent의 `whenReady` queue로 우회하지 않는다.
- Agent 준비, session 실행 또는 job 저장이 실패하면 완료나 전달 성공으로 표현하지 않고, 새 session 안의 retry
  가능한 오류와 authoring surface의 실행 실패 상태를 유지한다.
- 요청 제출 성공은 map 생성 완료가 아니라 전용 session과 tracked job이 시작됐다는 뜻이다.

### 진행 표시

- 버튼을 누른 뒤 준비가 끝날 때까지 **전용 Agent 세션 여는 중** transient 상태를 쓰고 중복 실행을 막는다.
- Tracked job이 반환되는 즉시 empty·creation·diagram 어느 화면에서도 사라지지 않는 compact status strip을 panel
  header 아래에 고정한다.
- Strip은 대상 Agent, exact job phase, 마지막 갱신 시각과 cooperative Cancel을 보이며
  **요청 저장 → 전용 세션 → Agent 작업** 세 milestone을 구분한다.
- Queued에서는 새 session의 첫 progress report를 기다린다고 표시한다.
- 이전 버전에서 복원된 기존 session job은 dispatch 방식을 추정하지 않고 **Agent 수락 또는 progress report 대기**로
  표현한다.
- 알 수 없는 진행률을 percentage나 animation으로 추정하지 않는다.

### 승인과 export

- Agent가 Draft와 Production을 통과해 `awaiting-review`를 보고해도 완료로 표현하지 않는다.
- 사람이 승인한 뒤에만 completed가 된다.
- Export는 exact approved fingerprint가 있을 때만 가능하다.
- Create/Update는 Agent orchestration control이며 자동 source write, 성공으로 가장한 generation, commit 또는
  merge action이 아니다.

### 반응형과 탐색

- 넓은 panel에서는 map rail, diagram, inspector가 나란히 있다.
- 좁아지면 선택된 inspector와 authoring이 아래로 흐른다.
- 선택 항목이 없는 좁은 상태는 빈 inspector를 숨기고 verification 통과 수와 Agent authoring 진입만 compact
  footer로 남겨 diagram 높이를 보존한다.
- Map은 panel resize나 Dockview 이동으로 remount하지 않는다.
- Fit은 camera만 바꾼다.
- Wheel zoom, zoom button, pointer pan, minimap, 검색, chapter, authored route, upstream/downstream은 같은
  stable semantic ID를 쓴다.

### 접근성과 locale

- SVG item과 relation은 keyboard focus와 accessible name을 가진다.
- 같은 내용을 탐색하는 semantic outline을 제공한다.
- 상태·검증은 색만으로 전달하지 않는다.
- Evidence button은 opaque project/root/workspace identity와 상대 경로·line만 source navigation에 전달한다.
- Motion은 기능 이해에 필요하지 않으며 `prefers-reduced-motion`에서는 즉시 상태 전환한다.
- App chrome은 현재 UI locale을 따르지만 map authored prose와 English identifier는 자동 번역하지 않는다.

### 검증

- Production Storybook은 다섯 mode의 영문·한국어 variant와 empty/create, cold open, background verification,
  active job, candidate, approved, stale, last-approved 상태를 고정 입력으로 보인다.
- Reader visual matrix는 1200×800 dark English와 800×600 light Korean에서 다섯 mode를 모두 검토한다.
- Creation baseline도 같은 두 viewport를 유지한다.
- Story는 layout·responsive·keyboard·axe 증거이며 임의 repository map의 사실성을 자동으로 증명하지 않는다.

## 21. 채팅의 두 스킨과 입력 공통

> 출처: 이전 §16.2, R7.1 (원본 보존: docs/ux/reviews/2026-10-23-ux2-baseline/frontend-design.md)
>
> 승인: v2 r6 2026-10-13 ([승인 기록](reference/v2/APPROVAL.md)), R7.1 2026-10-14

### 대화 내용과 AI 연결

> 출처: 이전 §10(앞부분)

- Agent의 사용자 메시지, 답변, 명령 인자와 도구 결과는 원문을 표시하고 host session history에도 원문을 보관한다.
  민감 표시가 있다는 이유로 내용을 숨기지 않는다. 진단 로그의 sanitization은 별도 경계다.
- 긴 도구 출력은 펼칠 수 있고, 같은 provider message의 delta와 완료 event는 한 메시지로 표시한다.
- 이전에 내용이 삭제·요약되어 저장된 기록은 복구된 것처럼 꾸미지 않는다.
- CLI 설치 탐색은 앱 대화 SDK 버전·인증·hook 준비와 분리한다. 앱 대화가 준비되지 않았어도 설치된 Codex/Claude
  CLI는 터미널에서 실행할 수 있고, 앱 대화 자리에는 짧은 안내와 AI 설정으로 가는 동작을 둔다. 실제 실행 권한과
  위험 작업 승인은 그대로 유지한다.
- 기록 행은 provider 이름 글자와 3px 시작 쪽 띠로 출처를 보이며, 색은 provider identity token에서 테마별로
  대비 보정한 값을 쓴다. provider 의미를 색에만 맡기지 않고, 진행 상태 표시는 provider와 무관한 색을 쓴다.

### 스킨

- 말풍선과 CLI 스킨은 같은 Session/Turn/message ID, transcript, 초안, 첨부, 답장, 도구 결과, 승인과 대기열을
  렌더링한다.
- 스킨은 기기별 보기 설정이다.
- 스킨 전환은 provider·권한·실행 상태·저장소를 바꾸거나 새 세션을 만들지 않는다.
- 실제 터미널은 별도 입력 대상이며 CLI 스킨의 입력을 PTY로 전달하지 않는다.
- 말풍선은 사용자 메시지의 경계를, CLI는 연속된 출력과 간결한 역할 표시를 강조한다.
- CLI 프롬프트 기호는 장식으로 처리하고 작성자·역할·상태는 의미 있는 텍스트로 읽힌다.

### 전환 중 보존

- 스킨 전환 시 초안, 커서·선택 범위, 답장, 첨부, 펼친 도구, 열린 산출물, 승인 대상과 대기 메시지를 보존한다.
- 스킨·테마 변경은 초안·선택·스크롤·펼침 상태를 초기화하지 않는다.
- Transcript는 읽던 메시지 ID를 기준으로 위치를 복원한다.
- 새 응답이 사용자의 입력 focus를 빼앗지 않는다.

### Composer 공통

- 하단 composer는 대화 scroll과 분리한다.
- 첨부·복사·답장·참조·AI 설정·전송은 두 스킨 모두에 있으며 실제 capability에 맞게 활성화한다.
- 설정은 입력창 주변에 둔다.
- Desktop은 좁은 패널에서도 Enter 전송, Shift+Enter 줄바꿈과 IME 조합 보호를 지킨다.
- Android는 Enter 줄바꿈, 버튼 전송이다.
- 응답 중 후속 입력은 대기열 추가와 현재 turn 중단을 구분한다.
- 메시지별 동작은 hover 없이도 keyboard·touch로 접근할 수 있다.
- 연속된 도구·추론 기록을 접어도 승인과 오류는 독립적으로 보인다.
- 실제 terminal의 Ctrl+C·붙여넣기·IME·세션 종료 의미는 바꾸지 않는다.

### 전송 신뢰성

- 전송 receipt 전에는 복구 가능한 초안을 유지한다.
- 결과가 불명확하면 호스트 기록과 대조하며 중복 전송하지 않는다.
- Android 오프라인에서는 캐시 열람과 미전송 초안을 제공한다.
- 재연결 자체로 전송하지 않는다.

## 22. 대화 상태·반응형과 AI 실행 정책

> 출처: 이전 §16.3 (원본 보존: docs/ux/reviews/2026-10-23-ux2-baseline/frontend-design.md)
>
> 승인: v2 r6 2026-10-13

- 대화 완료, 첨부·답장 작성, 응답 중, 승인 대기, 결과 검토를 두 플랫폼과 두 스킨에서 모두 제공한다.
- Loading·empty·error·offline·stale·conflict·unsupported를 구분하고 원인과 복구 행동을 표시한다.
- PC에서 대화와 산출물의 병치는 좁은 창에서 내용 전환으로 바꾸되 초안과 읽던 위치를 보존하며, 그 판단은 §24의
  결과물 배치 규칙을 따른다.
- Android는 한 열을 쓰고 결과는 명시적인 진입으로만 연다.
- Android에서 keyboard와 safe area가 입력과 전송을 가리지 않아야 한다.
- 터치·대비·zoom·reduced motion은 §12와 각 플랫폼 계약의 기준을 따른다.
- 역할별 AI 프로필은 편집, 버전 복원과 AI 수정 제안 비교를 지원한다.
- 제안 적용은 명시적이다.
- 제안 적용은 진행 중 attempt의 설정 snapshot을 바꾸지 않는다.
- 영향받는 작업과 그 후속 작업만 보류하고 무관한 작업은 유지한다.
- 검증 복구는 기본 추가 2회 뒤 사용자 판단을 기다린다.
- 전체 시간 제한은 두지 않는다.
- Provider 장애는 영향받는 작업만 대기시키고 사용자가 대체 대상을 고른다.
- 상세 상태·명령 경계는 [정책 계약](reference/v2/POLICY-CONTRACTS.md)을 따른다.

## 23. 채팅 행·도크·입력창

> 출처: 이전 §16.5 (원본 보존: docs/ux/reviews/2026-10-23-ux2-baseline/frontend-design.md)
>
> 승인: 2026-10-15

### 행

- 두 스킨은 같은 view-model([`src/renderer/chat/model`](../../src/renderer/chat/model))이 만든 행을 렌더링한다.
- 행 종류는 사용자, assistant 산문, 도구 실행 묶음, 계획, 질문, 작업 목록, 턴 변경 요약, 알림, 오류, 하위
  Agent, 턴 상태다.
- 도구 실행 묶음은 한 줄 요약("파일 2개 읽음, 명령 1개 실행함")으로 접히고, 펼치면 도구별 아이콘·동사·대상·종료
  코드·시간과 상세를 보인다.
- CLI 스킨은 같은 행을 `⏺ 도구(대상)`, `⎿` 결과, `✻` 상태의 고정폭 출력으로 보인다.
- 진행 중인 턴 상태는 턴 아래, 끝난 턴의 소요 시간은 턴 위에 둔다.
- 작업 목록 도구 호출은 별도 줄 대신 작업 행으로 보이며 연속 갱신은 한 행으로 합친다.
- 구 host나 payload 이전 대화도 텍스트 해석으로 같은 행을 만든다.

### 결정 도크

- 대기 중인 승인·질문·계획은 입력창 위 도크가 맡으며, 도크를 접고 입력할 수 있다.
- 도크 제목은 요청 종류를 UI 언어로 말한다.
- 질문과 계획에는 접근 위험 표시를 붙이지 않는다.
- 승인 대상 도구 줄은 실행 중이 아니라 승인 대기로 표시한다.
- 미완료 작업 목록은 별도 작업 도크로 고정한다.
- 결과물이 있는 PC에서 작업 도크는 진행 한 줄만 보이고, 누르면 결과물의 계획·작업을 연다.
- 턴 변경 요약은 transcript 안에서 펼치지 않고 그 턴(파일 행은 그 파일)의 변경 내역을 결과물에서 연다.
- 메시지 속 작업 위치 안 경로와 변경 기록의 경로는 링크이며 결과물의 파일에서 열린다.
- 창이 짧으면 도크 본문만 스크롤하고 제목과 결정 버튼은 항상 보인다.
- 도크는 창 높이의 70%를 넘지 않는다.
- 입력창의 Shift+Tab은 다음 순서로 하나만 한다. (1) 열린 입력 후보 목록이 있으면 닫는다. (2) 계획 모드를 바꿀
  수 있으면 켜고 끈다. (3) 결정이 기다려 계획 모드를 바꿀 수 없으면 도크의 주 버튼으로 이동하고 Enter로 결정한다
  (이동할 결정이 없으면 바꿀 수 없는 이유를 알린다).
- 도크 안의 Esc는 도크를 접고 입력창으로 돌아간다.

### 승인 범위

- 명령·파일 승인에는 host가 지원하면 `이 대화 동안 허용`/`이 대화 동안 편집 자동 승인`을 둔다(Codex
  `acceptForSession`, Claude는 CLI 제안을 이 세션에만 적용).
- 이 선택은 저장된 권한 단계를 바꾸지 않으며 대화가 다시 시작되면 다시 묻는다.
- Codex에는 거부 피드백이 없으므로 `피드백과 함께 거부`는 거부한 뒤 현재 턴을 멈추고 피드백을 다음 메시지로
  보낸다.

### 계획 승인

- 계획 승인 도크는 `계획대로 실행`과 `계획 계속 다듬기…`를 둔다.
- 승인한 계획이 어떤 권한으로 실행될지 `실행 권한` pill로 보이며, 그 값은 입력창 권한 pill과 같다.
- 답변 형식을 받지 않는 구 host에서는 권한 대신 `승인 후 실행으로 시작한다` 안내와 응답 없는 `계속 계획`을
  보인다.
- Codex 계획 모드 턴은 제안한 계획을 스스로 승인받지 않으므로, 사람이 보낸 계획 턴이 끝나면 host가 턴에 속하지
  않은 계획 승인(`plan-proposal-v1`)으로 실행 여부를 묻는다.
- 이 승인은 inbox, OS 알림, Android에서 다른 결정과 같게 보인다.
- 승인하면 고른 권한으로 계획 모드를 끄고, 승인한 사람 이름으로 `Implement the plan above.`를 보낸다.
- `계획 계속 다듬기`의 피드백은 계획 모드에서 다음 메시지로 간다.
- 새 메시지를 직접 보내면 이 승인은 만료된다.
- 이 기능이 없는 host에서는 화면이 같은 도크를 직접 만든다.

### 입력창 구성

- 입력창은 8줄까지 자동으로 커진다.
- 입력창은 `계획` 스위치, 모델·추론 강도·권한·작업 위치 pill, 원형 전송/중지 버튼과 `+` 메뉴를 가진다.
- 입력창 왼쪽 가장자리는 대화 AI의 색(대화 목록·탭과 같은 provider 색)이다.
- 빈 입력창 아래 한 줄은 단축키(Enter 전송 · Shift+Enter 줄바꿈 · Shift+Tab 계획)를, 응답 중에는 설정이 잠긴
  이유를 보인다.

### 작업 위치 pill

- Desktop의 작업 위치 pill은 `EZTerminal +2`처럼 작업 위치 이름과 함께 보는 폴더 수를 보인다.
- Desktop의 대화 헤더에는 작업 위치를 두지 않고 제목과 상태만 둔다.
- 새 대화는 작업 위치 pill 메뉴에서 작업 위치(새 워크트리 포함)를 고른다.
- 새 대화의 AI는 모델 pill 메뉴 위쪽 `AI` 목록에서 고르며, 입력창 위에 따로 선택칸을 두지 않는다.
- 시작한 대화의 pill 메뉴는 작업 위치(바꿀 수 없음), 함께 보는 폴더, 찾을 수 없는 폴더, 지침 파일 안내와
  `프로젝트 편집…`(project 편집 창)을 보인다.
- 좁은 창에서 작업 위치 pill은 아이콘과 `+N`만 남는다.
- Android는 대화 헤더에 작업 위치를 보인다. **대체 예정(B1)**: 1부 §7의 한 줄 채팅 헤더로 바뀌며 작업 위치는 ⋯
  시트와 입력창 칩에서 보인다.

### 모델·권한·계획

- 모델 pill은 `Codex · GPT-6-Astra`처럼 AI 이름을 앞에 붙이고 메뉴 제목은 `Codex 모델`이다.
- 모델을 고르지 않으면 `기본 모델`, 목록을 받기 전에는 메뉴에 `모델 불러오는 중…`을 보인다.
- 좁은 창에서는 AI 이름을 숨기고 색과 메뉴 제목이 남는다.
- 권한 pill은 접근 수준(`승인 후 실행`/`전체 권한`)만 고른다.
- 계획 모드가 켜져 있으면 권한 pill은 승인한 계획이 쓸 수준을 이 기기에 기억하며, 기억이 없으면
  `승인 후 실행`이다.
- `/clear`로 연 대화와 이어 연 대화는 원래 대화의 그 수준을 이어받는다.
- 새 대화는 사람이 마지막으로 고른 접근 수준으로 시작하며 다른 대화의 계획 모드를 가져오지 않는다.
- 입력창 안의 Shift+Tab은 계획 모드를 켜고 끈다(Codex·Cursor·Claude Code와 같은 관례, 우선순위는 위 도크 규칙).
  그래서 입력창에서는 Shift+Tab으로 앞 요소로 focus가 이동하지 않는다.
- 계획 스위치는 버튼으로도 조작할 수 있다.
- 응답 중에는 모델·권한·계획을 바꿀 수 없다는 이유를 보이며 추론 강도만 바꿀 수 있다.
- 예약 실행과 기획 단계처럼 사람이 지켜보지 않는 Agent에서 계획은 `계획만 · 읽기 전용`이며 승인을 기다리지
  않는다.

### 사용량 pill

- 설정 pill 줄 끝의 사용량 pill은 그 대화 AI의 5시간·주간 한도와 그 대화의 컨텍스트를 작은 게이지로 보인다.
- 누르면 항목별 막대, 사용률, 초기화까지 남은 시간(`2h10m 후 초기화`)과 값의 갱신 시각을 보인다.
- 탭을 열자마자 보인다. 마지막으로 받은 한도는 이 PC에 저장해 두었다가 먼저 보인다.
- 새 대화는 그 AI의 한도를, 기존 대화는 자기 컨텍스트도 함께 보인다.
- 값은 provider가 보고할 때마다 바로 갱신된다(Claude는 응답이 시작될 때, Codex는 탭을 열거나 대화를 시작할 때와
  모델 호출마다).
- 값이 없는 창(API key의 한도, 계정에 없는 5시간 창)과 초기화 시각이 지난 창은 숨긴다.
- 70% 이상은 경고색, 90% 이상은 위험색이며 상세에서 숫자로도 읽힌다.
- Pill의 접근 이름은 전체 문장이며 남은 시간은 읽어 주지 않는다.
- Android는 PC에 연결된 동안만 보이고 폰에 저장하지 않는다.
- EZTerminal은 로그인 토큰을 읽거나 사용량 endpoint를 직접 호출하지 않는다. Provider가 응답과 함께 보낸 값과,
  Codex에서는 설치된 Codex의 공식 한도 조회(`account/rateLimits/read`)만 쓴다.

### 좁은 창과 오류 표시

- 좁은 창(600px 미만)에서 설정은 한 줄을 유지하고 값은 줄이며 계획 스위치는 아이콘만 보인다.
- 대화 헤더는 제공자(와 Android의 작업 위치)를 먼저 숨기고 제목과 상태를 남긴다(Android 작업 위치는 B1에서
  헤더 밖으로 옮겨진다).
- 설정·세션 동작 실패는 대화 헤더 아래 전체 폭 알림 띠로 보인다.

### 대화 명령과 단축키

- 입력창의 `/plan`·`/model`·`/new`·`/clear`는 대화 명령이며 모델에 보내지 않는다.
- `/clear`는 같은 탭 자리를 같은 AI·모델·권한·강도·작업 위치의 새 대화로 바꾸고, 이전 대화는 기록에 남는다.
- 응답 중에는 `/clear`를 끝난 뒤 쓸 수 있다고 이유를 보인다.
- `/clear` 뒤에 쓴 글은 보내지 않고 새 대화 입력창에 남긴다.
- 바꿀 수 없는 화면(초안 포함)에서도 `/clear`는 뒤의 글과 함께 모델에 보내지 않는다.
- 응답 중 Esc는 대화 패널 어디서든 중지한다. 입력 필드·메뉴·대화상자·도크가 Esc를 먼저 받는다.
- 중지하면 대기열의 메시지를 버리지 않고 입력창으로 돌려준다.
- 빈 입력에서 ↑/↓는 이전 입력을 불러온다.
- Ctrl+F는 해당 대화 패널 안에서만 찾기를 열며, 가상화로 화면에 없는 행도 검색 대상이다.

### 긴 대화와 알림

- 긴 대화는 최근 기록부터 열고, 위로 스크롤하거나 `이전 메시지 불러오기`로 앞부분을 읽으며, 읽던 위치는 움직이지
  않는다.
- 대화 탭은 작업 중·승인 필요·안 읽은 완료·오류를 점으로 표시한다.
- 창이 비활성일 때 승인 대기·완료·실패를 OS 알림으로 알린다.
- 링크는 OS 브라우저로 연다(작업 위치 안 경로 링크는 위 결정 도크 절의 결과물 규칙을 따른다).

## 24. 대화 결과물

> 출처: 이전 §16.6, R7.1 (원본 보존: docs/ux/reviews/2026-10-23-ux2-baseline/frontend-design.md)
>
> 승인: 2026-10-20, R7.1 2026-10-14

### 정체성과 수명

- 대화마다 결과물 surface가 하나 있다.
- 제목은 `결과물 · {대화 제목}`이다.
- 대화 탭을 닫으면 결과물도 함께 닫힌다.
- 결과물은 분리 창으로 옮길 수 있고 레이아웃과 함께 복원된다.
- 복원할 때 대화가 없는 결과물 탭은 정리한다.
- 결과물은 프로토콜·DB 스키마를 바꾸지 않는다.

### Desktop 배치

- 같은 창에 결과물만 담은 그룹이 있으면 그 그룹의 탭으로 추가한다.
- 없으면 대화 그룹 폭이 720 CSS px × UI 배율 이상일 때 오른쪽으로 분할하고(폭 42%, 320~640 × 배율), 그보다 좁으면
  대화 그룹 안의 탭(내용 전환)이다. 병치·전환 판단은 대화 그룹 크기를 기준으로 한다.
- 활성 대화가 바뀌면 그 대화의 결과물 탭을 앞으로 가져오되 focus는 옮기지 않는다.
- 대화와 같은 그룹 안에서는 결과물이 대화를 가리지 않는다.

### 자동 열림

- 이 창에서 대화를 연 뒤(또는 그 60초 전 이후)에 생긴 결과물(변경 기록, 계획, 할 일)이 오면 결과물이 열린다.
- 대화가 뒤쪽 탭이면 그 대화를 볼 때 연다.
- 자동 열림은 입력 focus와 대화 스크롤을 바꾸지 않는다.
- 사람이 결과물을 닫은 대화는 다시 저절로 열지 않으며 이 기억은 기기에 둔다.
- 대화 탭을 닫는 것은 결과물을 닫은 것으로 치지 않는다.
- 기록 전용 대화에서는 자동으로 열지 않는다.
- 결과물은 턴 변경 요약과 파일 링크 같은 명시적 동작으로 언제든 열 수 있다.

### 변경 내역

- 범위는 최근 변경 턴(턴 선택 가능), 이 대화 전체, 작업 폴더(git, 마지막 커밋 이후 누가 바꿨든)이며 최근 변경
  턴과 전체 대화를 구분한다.
- 변경 검토는 현재 대화에 속한 완료된 provider 패치를 읽는다.
- AI가 보고한 변경임을 밝힌다.
- 명령으로 바뀐 파일은 작업 폴더 범위에서 본다.
- 긴 대화의 이전 변경은 요청할 때 읽고 취소할 수 있다.
- 줄을 고르고(클릭·Shift, 화살표·Shift, C) 의견을 모으면 `입력창에 넣기`가 현재 초안에 넣으며 전송을 시작하지
  않는다.
- 부분 기록(부분 Edit/Write 기록 포함)은 `부분 기록 · 줄 번호 없음`으로 표시하고 전체 diff나 파일 줄 번호로
  꾸미지 않는다.
- 확인함 표시는 특정 기록에만 적용되며 후속 기록은 다시 미확인으로 표시된다.

### 파일·산출물

- 대상은 AI가 만들거나 고친 파일과 링크로 연 파일이다.
- 마크다운은 미리보기·원본, 코드는 줄 번호와 색, 이미지, PDF(Chromium 뷰어)를 보인다.
- HTML은 격리된 정적 미리보기이며 스크립트를 실행하지 않는다.
- 상호작용이 필요하면 `브라우저로 열기`로 사람이 직접 연다.
- 미리보기 안에서 페이지가 바뀌면 `처음 페이지로`를 보인다.

### 계획·작업

- 최신 계획(대기 중이면 입력창 위 결정으로 이동), 할 일 진행, 이 대화의 파일, 지금 실행 중인 도구 호출(경과
  시간), 하위 AI, 기다리는 결정 수를 보인다.
- 백그라운드 명령은 앱이 추적하지 않으므로 보이지 않는다.

### 미리보기 격리 (패키지 빌드)

- 미리보기 URL은 파일 하나(PDF) 또는 페이지 폴더 하나(HTML)에 대한 무작위 일회성 권한이다.
- 쓰지 않으면 30분 뒤 사라지고 닫으면 반납한다.
- 페이지는 스크립트 없이 opaque origin에서 자기 권한의 파일만 불러온다.
- 폼·팝업·이동·다운로드가 없다.
- `..`, 숨김 이름, 인코딩된 구분자, 네트워크 공유·장치 경로, 밖으로 향하는 링크는 거부한다.
- 앱의 다른 iframe 이동은 미리보기와 PDF 뷰어로만 허용한다.
- 알려진 한계: `<link rel=preconnect>` 같은 연결 힌트는 CSP 대상이 아니므로 네트워크 차단은 최선 노력이다.
- 스크립트를 실행하는 미리보기는 네트워크를 막은 별도 세션의 뷰가 생길 때(브라우저 패널과 함께) 다시 검토한다.

## 25. 소프로젝트 흐름 캔버스

> 출처: 이전 §16.7, 승인된 후속 계약 · 소프로젝트와 실행 흐름, 이전 §17 (원본 보존: docs/ux/reviews/2026-10-23-ux2-baseline/frontend-design.md)
>
> 승인: 이전 §16.7 2026-10-22, r4 2026-10-13 ([승인 기록](reviews/2026-10-13-agent-workflow-r4-approval.md),
> [개선 계획](agent-workflow-plan.md), [r4 시안](reference/v2-agent-chat-r4/index.html))

### 범위

- 소프로젝트는 기존 논의의 기획 단위와 같은 대상이다.
- 한 캔버스에서 단계를 만들고, 실행 상태를 보고, 단계를 골라 제어한다.
- 단계별 재시도·건너뛰기·이 단계부터 다시 실행은 제공하지 않는다.
- 상세 flow·state·responsive는 [r4 UX 보완 계약](reference/v2-agent-chat-r4/UI-CONTRACT.md)을 구현 기준으로
  적용하되, 이 영역 규칙(I2, 2026-10-25)이 r4의 탭 구성·실행 준비 대화상자·고정 흐름 비교 규칙을 대신한다.
- 설계 승인은 제품 구현 완료나 실제 provider·기기 검증 통과를 뜻하지 않는다.
- r4 승인 범위와 원본 해시([`reviews/r4-approved/`](reviews/r4-approved/))를 보존한다.
- 이 영역 계약은 다른 영역 계약(대화, 결과물, 접근성 등)을 대체하지 않고 함께 적용된다.
- 단계 그래프는 사용자가 정의한 작업 흐름이며, 관리형 Agent의 부모·자식 관계를 채팅 track으로 표현하는 §15
  계약과 별개다.

### 구성

- `흐름` 화면은 머리줄, 실행 막대, 캔버스(또는 목록) 머리줄, 캔버스, 단계 칸으로 이뤄진다.
- 머리줄: `← 판`(데스크톱, 휴대폰은 프로젝트 항목으로), 이름, `이름·목표`, `AI와 흐름 편집`, `변경 기록`(누르면
  기록, 다시 누르면 흐름), `⋯`(다시 불러오기·실행 준비만·기획·설계·검토·흐름 편집 대화·완료/다시 진행·복사·보관/복원).
- 단계 칸은 한 컬럼이다. 순서: 종류·이름 → `실행 #n` 상태 → (승인 단계) `승인`/`거부` → (AI 단계) `이 단계 대화 열기`
  (작업 중이면 `작업 중인 대화 열기`, 이번 실행 대화가 없으면 비활성 + 이유)·`검토 대화 열기` → 범위 안내 → `이 단계 설정`
  (AI·모델·노력·지시, `고급` 접힘: 권한(계획만/승인 후 실행)·완료 조건·바꿀 수 있는 경로·실패하면 다시 시도) → (흐름 편집
  상태) `구조`(이름·동작·역할·입력·조건·합류·연결·시작 단계·이동·삭제) → 단계 문서·이 단계 대화 → `이 단계 기록`(회차·시도·
  검토·결과 상세, 접힘).
- 노력은 고른 모델이 알리는 값만 고른다(`모델 기본값` = 칸 없음).
- 아무것도 고르지 않으면 단계 칸은 실행 요약과 검증 문제를 보인다.
- 저장된 `view.page`(flow/stage/run)는 바꾸지 않는다. `run`은 그 단계의 `이 단계 기록`을 펼친 채 복원한다.

### 편집

- 단계 설정·단계 문서는 언제나 단계 칸에서 고친다(초안). 단계를 더하고, 끌고, 잇고, 지우는 일은 캔버스 머리줄
  `흐름 편집` 상태에서만 한다. 이 상태는 메모리에만 두고 다른 소프로젝트를 열면 닫는다.
- 노드 끌기, 카드 오른쪽 출력 포트(포트 이름 표시)에서 끌어 연결, 연결 끝 옮기기, Delete/Backspace(노드는 확인
  대화상자), 자동 정렬은 `흐름 편집` 상태에서, 확대·이동·Fit·미니맵은 늘 제공한다.
- 모든 편집은 초안만 바꾸며 `초안 저장`이 `workflow.patch`를 보낸다. 배치만 바뀐 저장은 `배치 변경`으로 기록한다.
- 실패·거절 포트에서 되돌아가는 연결에는 재시도 한도 2를 넣는다.
- 끌기 없이도 Tab·화살표 이동, 설정 폼, 목록 보기로 같은 편집을 할 수 있다.
- 편집은 실행을 시작하거나 승인하지 않는다.
- 실행 중 범위(단계 칸 안내, `stageEditScope`): 이번 실행에서 아직 보내지 않은 AI 단계(기다림·준비·보내기 전 멈춤)의
  설정은 저장하면 이번 실행에 반영된다. 이미 보냈거나 끝난 단계, 비-AI 단계, 단계의 구조·연결은 다음 실행부터다. 보낼
  결정이 난 뒤 끝날 때까지는 그 단계 설정이 잠기고(입력 비활성), 호스트도 `stage-locked`로 거절한다.

### 좌표

- 좌표는 UI 배율과 무관한 단위(카드 한 장 248×136)로 저장하고 그릴 때 배율을 곱한다.
- 예전 간격으로 저장돼 겹치는 흐름에는 `흐름 편집` 상태에서 `자동 정렬` 안내를 띄운다.

### 실행 겹침

- 보여 주는 실행은 아직 끝나지 않은(시작됨, 완료·취소 아님) 실행, 없으면 가장 최근 실행이다. 화면에 보이던 실행은
  끝나도 더 새 실행이 생길 때까지 유지한다. 판·작업 목록도 같은 실행과 같은 `실행 #n`(준비 순서 번호)을 쓴다.
- 편집 중인 흐름(저장본 또는 초안)의 단계·종류·연결·시작 단계가 실행이 고정한 흐름과 같으면(단계 자체 설정은 달라도 된다)
  같은 캔버스 노드에 실행 상태(아이콘·글자·테두리, 색만으로 구분하지 않음)와 연결 통과 수(`×n`, 재시도 `n/한도`)를 겹친다.
- 구조가 다르면 겹침을 숨기고 `진행 중인 실행 보기`로 고정 흐름을 읽기 전용으로 연다(배너와 `편집으로 돌아가기`).
- 노드 상태 우선순위는 취소 > 작업 상태 > 최근 회차이며, `완료`는 결과(통과·실패·허용)와 함께 쓴다.

### 실행 막대

- 한 줄: `실행 #n · 상태` → `다시 실행`(처음엔 `실행`) → 지금 성공할 수 있는 실행 동작(`승인 대기 n`, 준비만 된 실행의
  `실행 시작`, `일시정지`, `계속`, `실행 취소`, `검토된 결과 통합 허용`) → 실행 번호 선택(둘 이상일 때) → `결과`·`시작한 대화`
  → `승인`(내가 승인/자동 승인) → `검토 AI`(제공자·모델) → `반복`.
- `다시 실행`은 저장된 흐름을 저장된 설정으로 준비하고 시작하는 한 요청(`run.launch`)이다. 끝나지 않은 실행이 있거나,
  저장하지 않은 변경·검증 문제가 있거나, 검토 AI가 없으면 비활성이고 이유를 줄 아래에 쓴다.
- 승인 방식과 검토 AI는 소프로젝트에 저장해 모든 실행이 쓴다(검토 AI는 모델을 고를 때 저장). 자동 승인은 사람만 켠다.
- 호스트가 `workflow-launch-v1`을 알리지 않으면(이전 PC) 검토 AI 칸을 숨기고 `다시 실행`은 실행 준비 대화상자로 간다.
- 결과를 확인하지 못한 실행 요청은 `같은 요청 확인`과 `이 요청 그만두기`(실행 요청만, 이미 처리된 것은 그대로)를 보인다.
- 일시정지 중 진행할 단계가 없으면 `멈춤`을 표시한다. 실행 상태는 호스트의 실행 변경 알림으로 다시 읽는다.
- `반복`은 `끔`·`매일`·`매주`(+ 요일)와 시·분 선택이다(시각 입력란 대신 선택 상자: Android WebView에서 바로 저장된다).
  검토 AI가 저장되어 있어야 켤 수 있고, 처음 켤 때 이 기기의 시간대를 저장해 그대로 쓴다(다르면 시각 옆에 시간대를 쓴다).
  끄면 설정은 남는다. 켜져 있으면 줄 아래에 `다음 실행 …`과 `마지막: …`(실행함·건너뜀·놓침 n번·실행하지 못함)을 쓴다.
- 반복은 PC 앱이 로그인할 때 시작하고 창을 닫아도 계속 실행될 때만 돈다. 꺼져 있으면 이유와 `설정 열기`(데스크톱, 설정 › 일반)를,
  반복 기록을 읽을 수 없으면 반복을 멈췄다는 안내를 쓴다. 이 PC를 거치지 않고(프로젝트 폴더와 함께) 들어오거나 바뀐 흐름의
  반복은 돌지 않는다고 쓰고 `켜기`(지금 흐름 그대로)를 보인다. 판의 흐름 카드는 켜진 반복을 `매주 월 09:00`처럼 쓴다.
- 반복 규칙(호스트): 켜거나 시각을 바꾼 때보다 이른 회차는 돌지 않는다. 현지 날짜마다 한 번이며, 예정 시각 30분 안에 시작하지
  못하면 `놓침`으로 남는다(놓친 날은 시각을 그날 뒤로 옮기면 돈다). 앞 실행이 끝나지 않았으면 그 회차는 `건너뜀`이다.
  일정은 실행 준비·시작만 하고 승인·통합은 사람 몫(자동 승인 제외)이다.

### 렌더러와 플랫폼

- 데스크톱은 `@xyflow/react`를 지연 로드한다.
- 불러오지 못하면 간단한 그래프와 `다시 불러오기`를 보이며 초안과 선택은 유지한다.
- Android와 단위 테스트는 같은 화면을 정적 그래프로 그리고 목록이 기본이다.
- 정적 그래프에서는 끌기 대신 목록·폼·위/아래 이동 버튼을 쓴다.

### 카메라와 단계 패널 폭

- 카메라는 처음 보일 때 한 번 Fit하고, 소프로젝트·실행 보기별로 메모리에만 둔다.
- 컨테이너 폭 40rem 미만과 Android에서는 단계 패널이 캔버스 아래로 내려간다.
- 단계 패널 폭 상한은 22rem이며 좁은 도크에서는 폭의 약 3분의 1(최소 16rem)로 줄어 캔버스에 자리를 준다.
- 상단 바 오른쪽 끝의 `단계 패널 접기/펼치기`(`aria-expanded`)로 숨기면 캔버스가 전체 폭을 쓴다.
- 이 접기 선택은 프로젝트를 연 동안 소프로젝트 사이에서 유지하며 저장하지 않는다.
- 캔버스를 누르거나 끌어도 접힌 패널은 다시 열리지 않는다.
- `승인 대기 n`, 요약 목록, 단계 추가, 대화의 `이 단계로 돌아가기`처럼 단계로 가는 동작은 패널을 연다.
- Android에는 접기 버튼이 없다.

### 검증

- Storybook `Production/Workflow/Flow canvas`·`Project workspace`와 e2e [`workflow-canvas-run.spec.ts`](../../e2e/workflow-canvas-run.spec.ts)
  (실행 막대에서 검토 AI 저장 → `실행` → 캔버스에서 승인 → 작업 중인 단계 대화 열기 → 완료 → `다시 실행` = 실행 #2의 새 단계 대화)가 근거다.

## 26. 입력 후보·대화 탐색·통합 기록

> 출처: 이전 §17 (원본 보존: docs/ux/reviews/2026-10-23-ux2-baseline/frontend-design.md)
>
> 확정: r5 2026-10-14 ([r5 검수 기록](reviews/2026-10-14-agent-experience-r5.md))

- 앞선 검수 이력(r5 기록)은 보존한다.

### 탐색 목록 동작

- 목록의 펼침 화살표는 탐색만, 이름 선택은 본문 열기를 수행한다.
- 탐색 목록이 overlay로 보일 때 항목을 고르면 overlay만 닫고, 검색·펼침·스크롤을 복원한다.

### 입력 후보

- 입력창의 `+` 메뉴는 첨부·파일 참조·스킬·명령을 열고, 커서 위치에 후보 목록을 제공한다.
- `@`는 작업 위치의 파일을 찾아 경로 토큰으로 넣는다.
- `/`는 앱 동작과 provider 명령·스킬을 구별한다.
- Codex의 `$`는 스킬을 찾는다.
- Claude 호출은 실제 `/name` 구문을 쓴다.
- 후보 선택은 토큰만 교체하며 즉시 전송하지 않는다.
- Enter는 열린 후보 선택, Escape는 닫기이며 Tab은 원래 focus 이동이다.
- IME 조합을 가로채지 않는다.
- Android 후보는 키보드 위 입력창에 붙고 Enter는 줄바꿈이다.
- 조회 중·없음·검색 결과 없음·실패·이전 목록·비활성·미지원 상태를 구별한다.
- 키 입력마다 provider 조회를 반복하지 않는다.

### 대화 선택기

- 공통 대화 선택기는 검색·선택만 담당하며, 선택하면 닫히고 같은 대화 본문 화면으로 이동한다.
- 기본 범위는 현재 프로젝트이며 전체 범위로 넓힐 수 있다.
- 앱/CLI 출처, 제공자, 보관 여부를 독립적으로 필터링한다.
- 각 항목은 실제 소속과 시각을 표시한다.
- 목록은 대화 본문 전체를 읽지 않는다.

### 과거 기록과 이어가기

- 과거 CLI 기록도 공통 채팅 화면과 선택한 채팅 스킨으로 읽는다.
- 기록을 읽기만 해서는 provider 실행을 시작하지 않는다.
- 새 대화는 기본 제공자·작업 위치와 입력창을 즉시 보이고 첫 전송에서 생성한다.
- 과거 대화의 첫 전송은 원래 provider 세션을 검증해 이어간다.
- 별도 생성 폼이나 두 번째 이어가기 확인을 두지 않는다.
- 실제 PTY는 사용자가 `터미널에서 이어가기`를 명시적으로 고를 때만 연다.
- 이어가기 지원 실패를 새 대화나 PTY 전환으로 숨기지 않는다.

### 불러오기와 보존

- 대화 목록 맨 아래의 `대화 더 불러오기`와 대화 본문 위의 `이전 메시지 불러오기`를 구분한다.
- Windows의 탭·분할과 Android의 목록→대화→Back 흐름에서 초안·첨부·답장·선택한 스킬과 읽던 위치를 보존한다.
- 원래 기록과 이어진 앱 세션은 하나의 대화 ID와 목록 항목을 쓴다.
- 재실행 시 연결이 확인된 옛 CLI 탭은 기록으로 복원하고, 연결을 확인할 수 없는 탭은 종료 상태와 복구 동작을
  보인다.
- 모바일 초안과 최근 본문은 PC별 암호화 저장소에 보관한다.
- 생성·이어가기·전송의 정확한 요청은 전송 전에 저장하며 연결 복구만으로 재전송하지 않는다.
- 응답 유실은 같은 화면의 명시적 재시도로 확인하며 그동안 작성한 새 초안을 덮어쓰지 않는다.

## 27. UI 작업 공간과 대기열

> 출처: 이전 R7.1 (원본 보존: docs/ux/reviews/2026-10-23-ux2-baseline/frontend-design.md)
>
> 승인: 2026-10-14 ([R7.1 구현 기록](reviews/2026-10-14-conversation-r7-implementation.md))

### UI 작업 공간

- 프로젝트 문맥에서 시작한 대화와 터미널은 그 프로젝트의 실행 위치를 쓴다.
- UI 작업 공간(패널 배치 묶음)은 실행 위치·권한과 별개다.
- 서로 다른 프로젝트의 대화·터미널을 한 작업 공간에 함께 배치할 수 있다.
- 작업 공간은 이름 변경, 탭 이동, 분할, 집중 보기, 저장·복원을 제공한다.
- 공간 전환은 패널을 숨기는 동작이며 세션 종료나 provider 재실행이 아니다.
- 공간 닫기는 남은 공간으로 패널을 옮기며, 실제 종료는 기존 명시적 종료 동작을 따른다.

### 대기열

- 대기열은 호스트가 수락한 턴에서 읽는다.
- 대기 항목의 삭제·편집·중단 후 실행은 해당 턴의 revision을 검사하며, 실행을 시작한 항목에 오래된 편집 명령을
  적용하지 않는다.
- 편집은 호스트의 성공 응답 뒤에 입력창으로 가져온다.
- 편집을 가져올 때 기존 초안은 별도로 보관하고 전송 후 복원한다.
- 응답을 확인하지 못한 명령은 성공으로 표시하거나 자동 재전송하지 않는다.
- Capability가 없는 구 호스트에는 대기열 수정 조작을 제공하지 않는다.

## 근거 소스

- [`DESIGN.md`](../../DESIGN.md)
- [`docs/ux/overhaul/README.md`](overhaul/README.md)
- [`docs/ux/overhaul/entry-points.md`](overhaul/entry-points.md)
- [`docs/ux/overhaul/journeys-baseline.md`](overhaul/journeys-baseline.md)
- [`docs/ux/reference/2.0/manifest.json`](reference/2.0/manifest.json)
- [`docs/ux/reference/desktop-handoff/manifest.json`](reference/desktop-handoff/manifest.json)
- [`src/renderer/App.tsx`](../../src/renderer/App.tsx)
- [`src/renderer/dock-window-coordinator.ts`](../../src/renderer/dock-window-coordinator.ts)
- [`src/renderer/dockview-popouts.ts`](../../src/renderer/dockview-popouts.ts)
- [`src/renderer/WorkspaceTab.tsx`](../../src/renderer/WorkspaceTab.tsx)
- [`src/renderer/workbench/`](../../src/renderer/workbench/)
- [`src/renderer/ui/`](../../src/renderer/ui/)
- [`src/renderer/styles/ui-tokens.css`](../../src/renderer/styles/ui-tokens.css)
- [`src/renderer/i18n/resources.ts`](../../src/renderer/i18n/resources.ts)
- [`src/renderer/feature-loader.tsx`](../../src/renderer/feature-loader.tsx)
- [`src/renderer/project-conversation-tree-model.ts`](../../src/renderer/project-conversation-tree-model.ts)
- [`src/shared/resource-profile.ts`](../../src/shared/resource-profile.ts)
- [`mobile/src/MobileWorkbenchCoordinator.tsx`](../../mobile/src/MobileWorkbenchCoordinator.tsx)
- [`mobile/src/MobileSettingsView.tsx`](../../mobile/src/MobileSettingsView.tsx)
- [`mobile/src/MobileTabBar.tsx`](../../mobile/src/MobileTabBar.tsx)
- [`mobile/src/mobile-shell.css`](../../mobile/src/mobile-shell.css)

## 검증

- [`scripts/guard-design-reference.mjs`](../../scripts/guard-design-reference.mjs)
- [`test/design-reference-guard.test.ts`](../../test/design-reference-guard.test.ts)
- [`scripts/chrome-bands.mjs`](../../scripts/chrome-bands.mjs)
- [`mobile/e2e/chrome-probe.ts`](../../mobile/e2e/chrome-probe.ts)
- [`scripts/capture-ux-overhaul.mjs`](../../scripts/capture-ux-overhaul.mjs)
- [`src/renderer/workbench/DesktopHandoff.stories.tsx`](../../src/renderer/workbench/DesktopHandoff.stories.tsx)
- [`e2e/workbench-shell.spec.ts`](../../e2e/workbench-shell.spec.ts)
- [`e2e/popout-window.spec.ts`](../../e2e/popout-window.spec.ts)
- [`visual/storybook.visual.spec.ts`](../../visual/storybook.visual.spec.ts)
- [`mobile/src/MobileWorkbenchCoordinator.test.tsx`](../../mobile/src/MobileWorkbenchCoordinator.test.tsx)
- [`mobile/src/MobileUiPreferencesProvider.test.tsx`](../../mobile/src/MobileUiPreferencesProvider.test.tsx)

개편 전 원문은 [`reviews/2026-10-23-ux2-baseline/frontend-design.md`](reviews/2026-10-23-ux2-baseline/frontend-design.md),
그 이전 전체 규격과 완료 addendum은 [`docs/archive/design/frontend-design.md`](../archive/design/frontend-design.md)에
보존한다.
