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

EZTerminal의 기준 이미지는 **green-phosphor terminal과 operations console을 결합한
professional workbench**다. 사용자는 장식된 dashboard가 아니라 실제 세션, 파일,
agent와 원격 장치를 오래 다루는 도구를 보고 있다고 느껴야 한다.

Matrix 정체성은 신호처럼 선명한 accent, 어두운 계층형 surface, 절제된 scanline과
terminal 문법에서 나온다. 그러나 모든 theme에서 제품의 우선순위는 가독성, 실제
상태의 정직한 표현, 입력 안전성과 작업 연속성이다. 장식 때문에 text, focus, 오류,
권한 상태가 흐려지면 장식을 줄인다.

Desktop은 여러 작업을 밀도 있게 조율하는 authoring workbench이고, Android는 이동 중
빠르게 상태를 확인하고 명시적으로 원격 동작을 시작하는 companion이다. 두 platform은
같은 시각 언어를 쓰되 같은 화면을 축소 복제하지 않는다.

## Colors

색은 semantic role로 선택한다. application chrome은 `--ui-*`, 실제 terminal과 terminal
transcript는 `--term-*`를 사용한다. 정확한 palette와 theme별 값은 token foundation과
runtime theme registry만 정의한다.

- Accent는 선택, focus와 현재 작업의 방향을 드러내는 신호다. 넓은 면을 채우는 브랜드
  배경으로 쓰지 않는다.
- Surface 단계는 canvas, working surface, raised overlay와 inset data 영역의 깊이를
  만든다. 단순히 서로 다른 검정을 늘어놓지 않는다.
- Success, warning, danger와 info는 실제 상태 의미가 있을 때만 쓴다. 의미는 label,
  icon 또는 구조로도 전달한다.
- Glow와 scanline은 Matrix theme의 제한된 atmosphere다. Light와 High Contrast에서는
  형태와 경계가 먼저이며, custom theme에도 Matrix 색을 강제로 섞지 않는다.
- Remote video처럼 content 자체가 색을 소유하는 media plane은 chrome과 분리한다.
  그 위의 control은 전용 media semantic token으로 읽을 수 있어야 한다.

## Typography

제품 본문, 설정과 도움말은 편안한 local system UI typography를 사용한다. Display
face는 wordmark와 짧은 signal label에만, monospace는 command, path, diagnostic value,
terminal content처럼 고정 폭이 의미를 돕는 곳에만 사용한다.

한국어 문장 전체를 display 또는 terminal font로 만들지 않는다. Heading은 짧고 기능을
명명하며, metadata는 작아질 수 있지만 핵심 상태나 action보다 먼저 희미해져야 한다.
정확한 family, type scale와 line height는 token foundation이 소유한다.

## Layout

시각 hierarchy는 현재 작업, 그 작업의 context, 전역 navigation 순서다. Pane과 panel은
업무 단위로 보이고, 여러 border box가 같은 위계에서 중첩되어서는 안 된다. Compact한
density를 유지하되 빈 공간을 장식으로 채우지 않고 grouping과 scan path를 만드는 데
사용한다.

Desktop에서는 header와 activity rail이 안정된 frame을 만들고 workspace가 가장 큰
시각 무게를 가진다. Mobile에서는 현재 destination과 primary action이 먼저 보이고,
safe area와 touch anatomy가 terminal 장식을 이긴다. 정확한 geometry, breakpoint와
navigation anatomy는 UX 계약이 소유한다.

## Elevation

Elevation은 실제 interaction layer를 설명한다. Base workspace, sticky chrome, menu,
sheet, dialog, toast와 tooltip 순서를 공유 token으로 표현한다. Feature가 임의의 큰
`z-index`로 새 계층을 만들지 않는다.

Shadow는 surface를 canvas에서 분리하는 데 필요한 만큼만 쓴다. Neon bloom은 elevation의
대체물이 아니며, 모든 card와 text에 반복하지 않는다. Scrim은 뒤 화면이 비활성이라는
사실을 분명히 하되 foreground content의 contrast를 약하게 만들지 않는다.

## Shapes

EZTerminal의 shape는 정밀한 tool chrome에 가깝다. Control은 작고 명확한 corner,
workspace card와 dialog는 한 단계 부드러운 corner를 사용한다. Pill은 status, compact
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
- Icon은 Lucide 기반의 일관된 stroke language를 사용한다. Emoji를 product icon으로
  사용하지 않는다.
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

Storybook과 visual snapshot은 구현 증거이지 별도 규범 원천이 아니다. 고정 desktop
handoff는 의도 비교용 oracle이며, snapshot은 reference와 side-by-side 검토한 뒤에만
갱신한다. 외부 content와 remote media는 결정적으로 mask한다.

## 근거 소스

- [`src/renderer/styles/ui-tokens.css`](src/renderer/styles/ui-tokens.css)
- [`src/renderer/themes.ts`](src/renderer/themes.ts)
- [`src/renderer/ui/`](src/renderer/ui/)
- [`src/renderer/workbench/`](src/renderer/workbench/)
- [`mobile/src/mobile-shell.css`](mobile/src/mobile-shell.css)
- [`docs/ux/reference/desktop-handoff/manifest.json`](docs/ux/reference/desktop-handoff/manifest.json)

## 검증

- [`scripts/guard-design-style.mjs`](scripts/guard-design-style.mjs)
- [`src/renderer/styles/ui-tokens.test.ts`](src/renderer/styles/ui-tokens.test.ts)
- [`test/design-style-guard.test.ts`](test/design-style-guard.test.ts)
- [`test/design-surface-coverage.test.ts`](test/design-surface-coverage.test.ts)
- [`test/fixtures/design-eval/README.md`](test/fixtures/design-eval/README.md)
- [`visual/storybook.visual.spec.ts`](visual/storybook.visual.spec.ts)
