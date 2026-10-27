# EZTerminal Visual Design Contract

> 문서 상태: **활성 규범 계약**
>
> 이 문서는 EZTerminal이 어떤 제품처럼 보여야 하는지와 시각 판단 기준을 소유한다.
> 정보 구조, navigation, 상태 전이와 platform 동작은
> [`docs/ux/frontend-design.md`](docs/ux/frontend-design.md), 실제 색상·간격·크기 값은
> [`themes.ts`](src/renderer/themes.ts)와
> [`ui-tokens.css`](src/renderer/styles/ui-tokens.css)가 소유한다. 문서가 값을 복사해
> 두 번째 token source가 되어서는 안 된다.

## Overview

EZTerminal의 기준 이미지는 **대화·기획·실행을 연결하는 차분한 professional workbench**다.
현재 작업과 산출물에 가장 큰 시각적 공간을 주고, 상태·요청·실제 실행 대상을 명확하게
표현한다. 사용자는 세션, 파일, agent와 원격 장치를 오래 다루는 도구를 보고 있다고 느껴야 한다.

2026-10-13 승인한 [v2 r6 기준](docs/ux/reference/v2/APPROVAL.md)을 반영한다. 기본 스킨은
말풍선이며 기존 사용자의 theme·skin 설정은 보존한다. 2.0(I4, 2026-10-27)부터 **새 설치의 기본 테마는
데스크톱·Android 모두 Matrix**다. 테마를 저장한 적 없는 기존 설치는 첫 실행에 보던 Dark를 기록해 외형을
유지하고, 저장된 테마(고른 것이든 기본값이든)는 바꾸지 않는다. 기본값이 적은 테마에는 출처(`default`/`user`)를
함께 남긴다.

2026-10-15 UX 개편에서 Dark/Light 기본 팔레트를 **Ink 방향**으로 확정했다. 따뜻한 차콜
canvas와 그 위로 한 단계씩 밝아지는 surface, 파란 signal accent를 쓰며 terminal pane도 같은
canvas 위에 놓인다. Matrix는 같은 정체성을 유지하되 surface 단계와 경계를 더 또렷하게 한
**Refined** palette를 쓴다. 두 결정은 새 채팅 행 위에서 다시 확인해 확정했다. 승인된 의도와 현재 구현의 일치 여부는
[구현 진행 기록](docs/ezterminal-v2-implementation.md)에서 따로 검증한다.

2026-10-24 사용자가 ux2 방향 **Board + Desk**를 Storybook 실물로 승인했다. 시각 언어는 **계기판**이다: 바닥(floor)
위에 판(plate)이 놓이고 판 사이는 홈(groove)으로 나뉘며, 살아 있는 상태는 작은 램프(LED)가 빛으로 알린다. 빛은 램프와
활성 신호에만 있고 글자에는 glow를 주지 않는다. Matrix는 이 언어의 기준 팔레트(초록 램프, 호박색 = 사람을 기다림,
붉은 램프 = 오류로 멈춤)이며, Dark·Light·High Contrast·사용자 테마는 같은 구조(판·홈·램프·작은 반경·라벨 face)에 자기
팔레트를 쓴다.

Matrix 정체성은 신호처럼 선명한 accent, 어두운 계층형 surface, 절제된 scanline과
terminal 문법에서 나온다. 그러나 모든 theme에서 제품의 우선순위는 가독성, 실제
상태의 정직한 표현, 입력 안전성과 작업 연속성이다. 장식 때문에 text, focus, 오류,
권한 상태가 흐려지면 장식을 줄인다.

Desktop은 여러 작업을 밀도 있게 조율하는 authoring workbench이고, Android는 이동 중
빠르게 상태를 확인하고 명시적으로 원격 동작을 시작하는 companion이다. 두 platform은
같은 시각 언어를 쓰되 같은 화면을 축소 복제하지 않는다.

Agent 작업은 Project → Workspace → Session의 맥락을 유지하되 모든 관리형 Agent를 같은
대화 surface로 표현한다. 부모와 자식 관계는 별도 dashboard나 그래프 편집기가 아니라 composer
위의 작은 track과 session tab의 provenance로 드러낸다. 평상시에는 상태와 짧은 요약만 보이고
입력 대기, 실패, 승인 요청처럼 사용자의 판단이 필요한 순간에만 시각적 무게를 높인다. 사용자는
부모뿐 아니라 자식 Agent도 직접 열어 대화하고 권한·모델·lifecycle을 제어할 수 있어야 한다.

말풍선과 CLI는 동일한 메시지 기반 채팅의 시각 표현이다. 말풍선은 메시지별 영역을 드러내고,
CLI 스킨은 좌측에 이어지는 출력, 간결한 작성자·역할 표시와 프롬프트 표현을 사용한다.
CLI 외형에서도 첨부·답장·승인·전송 같은 채팅 조작이 식별되어야 하며, 실제 셸 입력창으로
오해하게 하는 가짜 경로·PTY 상태를 추가하지 않는다. 실제 터미널은 기존 도구로 유지한다.

채팅은 작업을 보고하되 소음을 만들지 않는다. 여러 도구 호출은 한 줄 요약으로 접히고, 펼쳤을 때만
명령·대상·결과가 드러난다. 사람의 판단이 필요한 승인·질문·계획만 입력창 위에서 무게를 갖는다.
코드 색은 theme마다 keyword·함수·문자열을 구분하되 상태 색의 의미를 빼앗지 않는다.

## Colors

색은 semantic role로 선택한다. application chrome은 `--ui-*`, 실제 terminal과 terminal
transcript는 `--term-*`를 사용한다. 정확한 palette와 theme별 값은 token foundation과
runtime theme registry만 정의한다.

- Accent는 선택, focus와 현재 작업의 방향을 드러내는 신호다. 넓은 면을 채우는 브랜드
  배경으로 쓰지 않는다.
- Surface 단계는 canvas, working surface, raised overlay와 inset data 영역의 깊이를
  만든다. 단순히 서로 다른 검정을 늘어놓지 않는다.
- Success, warning, danger와 info는 실제 상태 의미가 있을 때만 쓴다. 의미는 label,
  icon 또는 구조로도 전달한다. 계기판 언어에서 호박색(warning)은 **사람을 기다리는 것**(승인·질문)이고, 그 판의
  작은 글자는 muted보다 한 단계 밝게 둔다.
- 램프는 상태를 보여 주지만 혼자 말하지 않는다. 램프 옆에는 항상 같은 상태를 글자로 쓴다.
- Glow와 scanline은 Matrix theme의 제한된 atmosphere다. Dark, Light와 High Contrast에서는
  형태와 경계가 먼저이며, custom theme에도 Matrix 색을 강제로 섞지 않는다. Matrix 안에서도
  glow는 focus, 활성 pane, 실행 중 상태처럼 살아 있는 signal에만 쓰고 dialog나 hover 같은
  일반 elevation에는 쓰지 않는다.
- Hover, selected, status tint 같은 파생 role은 theme별로 미리 계산된 값이다. Android
  WebView 하한에서 평가되지 않는 런타임 색 혼합을 feature CSS에서 쓰지 않는다.
- Remote video처럼 content 자체가 색을 소유하는 media plane은 chrome과 분리한다.
  그 위의 control은 전용 media semantic token으로 읽을 수 있어야 한다.

## Typography

제품 본문, 설정과 도움말은 편안한 local system UI typography를 사용한다. Display
face는 wordmark와 짧은 signal label에만, monospace는 command, path, diagnostic value,
terminal content처럼 고정 폭이 의미를 돕는 곳에만 사용한다.

한국어 문장 전체를 display 또는 terminal font로 만들지 않는다. Heading은 짧고 기능을
명명하며, metadata는 작아질 수 있지만 핵심 상태나 action보다 먼저 희미해져야 한다.
한국어 본문은 Noto Sans KR(없으면 맑은 고딕)을 먼저 쓴다. Heading, 판의 라벨, 스위치와 개수는 반각 **label face**
(Barlow Semi Condensed, 번들 OFL)로 모든 theme에서 같고, 한글은 본문 face로 이어진다. display face(Share Tech
Mono)는 wordmark와 프롬프트 기호에만 쓴다.
채팅과 chrome 안의 code는 사용자가 고른 terminal font를 따른다.
정확한 family, type scale와 line height는 token foundation이 소유한다.

## Layout

시각 hierarchy는 현재 작업, 그 작업의 context, 전역 navigation 순서다. Pane과 panel은
업무 단위로 보이고, 여러 border box가 같은 위계에서 중첩되어서는 안 된다. Compact한
density를 유지하되 빈 공간을 장식으로 채우지 않고 grouping과 scan path를 만드는 데
사용한다.

Desktop에서는 위 막대 하나가 안정된 frame을 만들고, 그 아래 **판**(프로젝트 홈) 또는 **작업 모드**(작업 목록 + 도크)가
가장 큰 시각 무게를 가진다. 판은 줄(lane)마다 왼쪽에 라벨, 오른쪽에 판들을 놓고 오른쪽 칸에 사람을 기다리는 것을 둔다. Mobile에서는 현재 destination과 primary action이 먼저 보이고,
safe area와 touch anatomy가 terminal 장식을 이긴다. 정확한 geometry, breakpoint와
navigation anatomy는 UX 계약이 소유한다.

## Elevation

Elevation은 실제 interaction layer를 설명한다. Base workspace, sticky chrome, menu,
sheet, dialog, toast와 tooltip 순서를 공유 token으로 표현한다. Feature가 임의의 큰
`z-index`로 새 계층을 만들지 않는다. 패널 안에 떠 있는 비모달 창(곁가지 질문 창)은 sticky
chrome 층에 두어 menu·sheet·dialog 아래에 머물고, scrim 없이 뒤 화면을 활성으로 남긴다.

Shadow는 surface를 canvas에서 분리하는 데 필요한 만큼만 쓴다. Neon bloom은 elevation의
대체물이 아니며, 모든 card와 text에 반복하지 않는다. Scrim은 뒤 화면이 비활성이라는
사실을 분명히 하되 foreground content의 contrast를 약하게 만들지 않는다.

## Shapes

EZTerminal의 shape는 정밀한 tool chrome에 가깝다. 판은 깎아 낸 듯한 작은 corner(둥근 pill 대신 같은 작은
반경)를 쓰고, control은 작고 명확한 corner, workspace card와 dialog는 한 단계 부드러운 corner를 사용한다. Pill은 status, compact
choice 또는 chip처럼 형태가 의미를 더할 때만 쓴다. 서로 인접한 control은 같은 높이와
edge rhythm을 공유한다.

정확한 radius와 control size는 token foundation이 소유한다. Feature-local 숫자로 거의
같은 shape를 새로 만들지 않는다.

## Components

새 화면은 [`src/renderer/ui/`](src/renderer/ui/)의 production primitive와 이미 제품에서
사용 중인 composition을 먼저 사용한다. Button, form control, menu, dialog, sheet,
feedback와 toast의 시각·접근성 문법을 feature마다 다시 만들지 않는다.

- Primary action은 화면마다 소수이며 accent와 동사 label로 명확히 한다.
- Destructive action은 danger 의미, 구체적 결과와 안전한 initial focus를 함께 가진다.
- Selected, hovered, focused, disabled와 loading은 서로 구별되고 color 하나에 의존하지
  않는다.
- Loading, empty, offline, permission denied, unsupported와 stale state는 실제 원인과
  recovery를 숨기지 않는다. 가짜 성공 데이터로 layout을 채우지 않는다.
- 셸·판·작업 목록·흐름의 icon은 [`ui/Glyph.tsx`](src/renderer/ui/Glyph.tsx)의 채운 스텐실 glyph이고, 나머지는
  Lucide stroke icon을 쓰며 단계마다 glyph로 옮긴다. Emoji를 product icon으로 사용하지 않는다.
- External provider content와 remote video는 제품 frame 안에 들어오지만 body를
  EZTerminal component처럼 위조하지 않는다.

## Platform Expression

Desktop은 keyboard-first, multi-pane, 높은 정보 밀도와 긴 작업 흐름을 강조한다.
Hover는 보조 신호일 뿐이며 keyboard focus와 pointer action이 같은 hierarchy를 가진다.

Mobile은 한 손 navigation, 안정된 page header, 충분한 touch target과 명시적 Start/Stop
action을 강조한다. Desktop pane을 좁혀서 mobile page로 만들지 않는다. PC Control은
immersive media surface를 사용할 수 있지만 연결, 권한, 종료와 복구 action은 항상
제품 chrome으로 식별되어야 한다.

## Do's and Don'ts

Do:

- concrete terminal reference와 실제 production state를 함께 비교한다.
- semantic token, shared primitive와 이미 검증된 story를 출발점으로 삼는다.
- hierarchy를 contrast, spacing, type와 structure의 조합으로 표현한다.
- Matrix, Dark, Light, High Contrast와 custom theme에서 의미가 보존되는지 확인한다.
- Korean/English, reduced motion, keyboard, screen reader와 touch 흐름을 함께 확인한다.

Don't:

- generic SaaS dashboard처럼 균일한 card grid와 무관한 KPI를 추가하지 않는다.
- 모든 surface에 glow, gradient, scanline 또는 green accent를 반복하지 않는다.
- 제품 전체를 monospace로 만들거나 emoji를 navigation icon으로 쓰지 않는다.
- component 안에 theme-specific color, font stack 또는 독립 z-index ladder를 고정하지
  않는다.
- 화면을 그럴듯하게 만들기 위해 존재하지 않는 session, device, permission 또는
  success state를 만들지 않는다.
- 고정 handoff의 raster나 외부 provider body를 production asset으로 복제하지 않는다.

## Working Method

UI 변경 전에는 이 문서, [`docs/ux/frontend-design.md`](docs/ux/frontend-design.md), 관련
production story/component 순서로 읽는다. 판단이 충돌하면 시각 정체성은 이 문서,
flow·state·responsive·accessibility는 UX 계약, 정확한 값은 runtime token/theme가
우선한다.

Storybook과 visual snapshot은 구현 증거이지 별도 규범 원천이 아니다. 의도 비교 기준은
사용자가 승인한 [2.0 reference](docs/ux/reference/2.0/manifest.json)이며, 아직 대체되지 않은
화면은 보관된 1.0 desktop handoff를 기준으로 한다. Snapshot은 기준과 side-by-side 검토한
뒤에만 갱신한다. 외부 content와 remote media는 결정적으로 mask한다.

## 근거 소스

- [`src/renderer/styles/ui-tokens.css`](src/renderer/styles/ui-tokens.css)
- [`src/renderer/themes.ts`](src/renderer/themes.ts)
- [`src/renderer/ui/`](src/renderer/ui/)
- [`src/renderer/shell/`](src/renderer/shell/)
- [`src/renderer/workbench/`](src/renderer/workbench/)
- [`mobile/src/mobile-shell.css`](mobile/src/mobile-shell.css)
- [`docs/ux/reference/2.0/manifest.json`](docs/ux/reference/2.0/manifest.json)

## 검증

- [`scripts/guard-design-style.mjs`](scripts/guard-design-style.mjs)
- [`src/renderer/styles/ui-tokens.test.ts`](src/renderer/styles/ui-tokens.test.ts)
- [`test/design-style-guard.test.ts`](test/design-style-guard.test.ts)
- [`test/design-surface-coverage.test.ts`](test/design-surface-coverage.test.ts)
- [`test/fixtures/design-eval/README.md`](test/fixtures/design-eval/README.md)
- [`visual/storybook.visual.spec.ts`](visual/storybook.visual.spec.ts)
