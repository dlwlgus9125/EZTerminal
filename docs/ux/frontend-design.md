# EZTerminal 적응형 Workbench UI/UX 계약

> 문서 상태: **활성 규범 계약**
>
> 이 문서는 현재 Electron desktop과 Android client의 제품 UI 계약이다. 화면 구현,
> Storybook, 접근성 검사와 시각 스냅샷은 이 계약에 동의해야 한다. 코드와 문서가
> 어긋나면 회귀인지 의도된 변경인지 먼저 결정하며, 코드를 이유로 문서를 자동
> 수정하지 않는다.

## 1. 범위와 우선순위

이 문서는 정보 구조, navigation, layout, visual language, responsive behavior,
접근성, localization과 UI 상태를 소유한다. 셸 실행, IPC, pairing, 원격 protocol,
process lifecycle은 [`architecture.md`](../architecture.md)와 `docs/design/` 계약이
소유한다.

결정 우선순위는 다음과 같다.

1. Desktop은 terminal-first authoring surface이고 Android는 remote-control-first
   companion이다.
2. 같은 기능에는 하나의 상태 소유자만 두고 여러 효율적인 진입점만 허용한다.
3. 선택, preview, insertion, drop과 navigation은 명시적 실행을 뜻하지 않는다.
4. navigation 중 terminal controller, draft, scroll, xterm geometry, reconnect와
   selection을 보존한다.
5. Matrix/CRT 정체성보다 가독성, truthful state와 reduced motion을 우선한다.
6. keyboard, pointer, touch와 assistive technology가 같은 작업을 끝낼 수 있어야 한다.
7. 한국어와 영어를 동등한 제품 언어로 취급한다.

## 2. 시각 방향과 소스 권한

선택된 방향은 **prototype-led, production-safe adaptive workbench**다. 고정 prototype의
geometry, hierarchy, density와 visual rhythm을 따르되 실제 서비스 상태, 보안 계약과
지원 viewport를 거짓으로 만들지 않는다.

추출된 reference와 story mapping은
`docs/ux/reference/desktop-handoff/manifest.json`이 고정한다. Package 2 prototype은
visual intent, handoff README는 구현·QA 수용 기준, 이 문서는 responsive·접근성·상태
계약을 소유한다. terminal semantics, 보안, 데이터 무결성과 실제 runtime 상태가
항상 prototype의 예시 값보다 우선한다.

세 줄 signal mark, 전체 `EZTerminal` wordmark와 green phosphor/scanline이 Matrix
identity의 핵심이다. 원본 raster는 reference일 뿐 제품 asset으로 삽입하지 않는다.
제품 icon은 Lucide를 사용하고 provider logo나 remote font를 추가하지 않는다.

## 3. Desktop application shell

### 3.1 Layout anatomy

1200px 이상에서는 header, activity rail, 하나의 `SidebarShell`, Dockview workspace와
status/feedback 영역을 사용한다. Sidebar는 280–440px, 기본 320px이며 resize 결과를
저장한다. 1200px 미만에서는 terminal 위의 단일 overlay와 scrim으로 바뀐다.

지원 desktop viewport는 800×600, 1024×720, 1200×800, 1440×900과 1920 reference다.
100%와 150% UI scale 모두에서 document-level horizontal scroll, terminal overlap과
접근 불가능한 primary action이 없어야 한다.

### 3.2 Header: exactly four zones

Header는 제품 기능 기준으로 정확히 네 zone을 가진다.

1. **New Terminal** — signal mark와 전체 wordmark, terminal 생성 action
2. **Command Center** — 실제 shortcut을 표시하는 넓은 anchor field
3. **Workspace** — Split, Layout과 Presets
4. **Agent Attention** — attention count와 focus/open action

`FX·NEON n`은 zone 4의 compact appearance utility이며 다섯 번째 navigation zone이
아니다. `n`은 0–10, 기본 7이고 동일한 Appearance setting을 연다. Theme, Files,
Stats, Pairing, Settings와 OpenClaw를 독립 header button으로 되돌리지 않는다.

Header는 60px, activity rail은 62px이며 rail action은 44px target을 유지한다. Pane
card는 12px radius와 인접 pane이 합쳐 만드는 14px gutter를 사용한다.

### 3.3 Activity Rail

위에서 아래 순서는 고정한다.

1. Agents
2. Monitor
3. Remote
4. Explorer
5. OpenClaw — integration이 사용 가능할 때만

Settings는 아래에 고정한다. 각 action은 Lucide icon, tooltip, localized accessible
name과 color 외의 selected state를 제공한다. 기능별 별도 drawer나 두 번째 rail을
만들지 않는다.

### 3.4 Sidebar destinations

- Explorer는 file navigation, breadcrumb와 preview 진입점을 소유한다.
- Agents는 Attention, Projects, Active, Recent 순서와 follow-up/launch/history를
  소유한다.
- Monitor는 system stats와 packet/traffic을 합친다. producer는 실제로 visible할 때만
  poll/capture한다.
- Remote는 pairing, remote access, device roster, PC Control 상태와 SSH forwarding을
  합친다.
- OpenClaw는 lifecycle/config/session/log navigation을 제공하고 chat은 Dockview panel의
  실제 `WebContentsView` 구현을 사용한다.
- Settings는 3.6의 category를 같은 shell에서 연다.

각 destination은 loading, empty/unavailable, error/offline과 success 상태를 정의한다.
Overlay를 닫으면 rail item 또는 Command Center result로 focus를 돌린다.
Optional destination은 첫 사용 전까지 별도 module로 유지할 수 있다. rail focus,
pointer enter/down은 사용자 intent이므로 preload할 수 있지만 click 동작과 accessible
name은 바꾸지 않는다. 로드 중에는 동일한 SidebarShell 안에 status를 보여 주고 실패하면
localized Retry와 Close를 함께 제공한다. terminal workspace, draft와 navigation은 이
오류 경계 밖에서 계속 사용할 수 있어야 한다.

### 3.5 Workspace와 composer

Workspace pane, tab, draft, PTY와 hidden panel은 layout 전환 중 살아 있어야 한다.
1+2, 2×1과 single preset은 active/MRU pane을 기준으로 한 non-destructive Dockview
transaction이며 overflow pane을 tab으로 유지한다.

Active pane composer는 48px 높이, 최대 820px이고 작은 폭에서는 document overflow
없이 줄어든다. terminal-specific keyboard, paste와 close safety를 app chrome shortcut이
가로채지 않는다.

### 3.6 Settings information architecture

Settings category는 다음 여섯 개다.

1. General
2. Appearance
3. Terminal & Safety
4. Agents
5. Integrations
6. About & Diagnostics

General은 언어·density·resource profile, Appearance는 theme·font·CRT, Terminal &
Safety는 terminal behavior와 paste/clipboard/close 안전 설정을 소유한다. Pairing,
OpenClaw와 provider 설정은 Integrations에 둔다. version과 diagnostic metadata는
About & Diagnostics에 둔다.

### 3.7 Resource profile

Resource profile은 기능을 제거하는 mode가 아니라 optional 화면의 preload와 관찰용
refresh 비용을 선택하는 device-local 설정이다.

| 선택 | Optional 화면 | 관찰 refresh | UX 계약 |
| --- | --- | --- | --- |
| Balanced (기본) | idle 시 preload | 표준 주기 | 일반적인 반응성과 자원 사용의 균형 |
| Low resource | focus/pointer intent에서 preload | 허용 목록만 2배 주기 | 기능·알림·안전 검사는 유지 |
| High responsiveness | 설정 복원 직후 preload | 표준 주기 | 첫 진입 지연을 우선 |

선택은 즉시 저장되고 다음 refresh 예약부터 적용한다. 이미 불러온 module은 강제로
unload하지 않으므로 Low resource 선택 시 완전한 메모리 회수는 다음 앱 시작부터라는
안내를 표시한다. 어느 선택도 timeout, reconnect/liveness, command cancellation,
backpressure, capture lease나 위험한 pane 닫기 확인을 느리게 해서는 안 된다.

### 4.5 Command Center and duplicate entry policy

> 이 section 번호는 고정 desktop handoff 계약이 참조하므로 유지한다.

Command Center는 keyboard-first global entry surface이며 기존 기능을 검색하거나
navigation한다. 기능 상태를 복제하지 않는다.

| Capability | Primary home | Additional entry |
| --- | --- | --- |
| Theme | Settings → Appearance | Command Center action |
| Files | Explorer | Command Center file search |
| Split/Layout/Presets | Workspace menu | Command Center action |
| Quick Commands | Composer shelf | Command Center manager/search |
| Agents/Monitor/Remote/OpenClaw/Settings | Activity Rail | Command Center navigation |

하나의 maintained implementation만 사용하며 labelled modal, keyboard navigation,
active result, focus trap, stale search cancellation과 focus restoration을 제공한다.
`Ctrl/Cmd+K`는 non-editable app UI에서만 열리고 xterm, composer, input, textarea와
contenteditable은 원래 key 의미를 유지한다. `Ctrl/Cmd+Shift+P`는 global alias다.

## 5. Android application shell

### 5.1 Navigation

인증 후 persistent navigation은 Home, Terminal, PC, Agents, More의 다섯 item이다.
PC는 capture를 자동 시작하는 tab이 아니라 명시적 Start action이다. 600dp부터 같은
순서의 72px left rail로 바뀌며 Settings를 아래에 둔다.

Home은 PC Control availability/start, connection, 최근 세션, 첫 Agent attention과
조건부 OpenClaw shortcut을 보여 준다. Home 자체는 capture/input이나 live stats를
시작하지 않는다.

### 5.2 Persistent terminal layer

`MobileWorkbenchCoordinator`는 항상 mounted인 TerminalLayer, 현재 page, navigation과
sheet/dialog host를 형제로 구성한다. Terminal이 선택되지 않았을 때 layer는 inert하고
`aria-hidden`이지만 `display:none`이나 unmount를 사용하지 않는다. draft, controller,
xterm geometry, scroll, selection, output과 reconnect 상태를 유지한다.

Android Back 순서는 다음과 같다.

1. top sheet/dialog
2. destination 내부 subpage 또는 preview
3. full-screen destination에서 invoker/tab root로 복귀
4. root에서 platform delegate

명시적 close는 history layer를 한 번만 소비하고 ghost entry를 남기지 않는다.

### 5.3 Page와 설정

일반 destination은 Back, localized title, optional status와 destination action으로 된
하나의 page-header composition을 사용한다. PC Control만 immersive chrome을 사용한다.
Terminal header는 Back, session sheet와 New만 유지한다.

Mobile Settings는 General, Appearance, Terminal & Input, Integrations,
Connection & About의 index/subpage 구조다. 기존 setting key와 theme format을
변경하지 않는다. General의 resource profile은 Android 기기에만 저장하고 desktop으로
동기화하지 않는다. desktop과 같은 세 label, 설명과 Low resource 재시작 안내를
사용한다.

### 5.4 Pairing과 연결 상태

Connection 화면은 manual URL/token과 QR scanner를 제공한다. 자동 network discovery,
다중 profile 또는 deep link는 제공하지 않는다.

- QR code는 memory-only, single-use이며 5분 후 만료한다.
- 성공하면 같은 Android secure credential store에 장기 token을 저장하고 code를 즉시
  폐기한다.
- camera permission은 scanner를 열 때만 요청하며 frame은 기기에서 decode하고 저장·전송
  하지 않는다. 모든 exit path에서 stream을 release한다.
- camera 거부 또는 미지원 기기는 동일한 수동 입력 경로를 사용한다.
- credential loading, connecting, VPN warning, auth rejection, protocol incompatibility,
  secure-storage warning과 success는 안정된 geometry와 inline recovery를 유지한다.

### 5.5 Responsive와 safe area

지원 viewport는 360×800, 412×915, 600×960과 915×412다. 모든 touch target은 최소
44×44 CSS px이고 user zoom을 허용한다. document는 가로로 scroll하지 않으며 tab과
accessory strip만 내부 scroll할 수 있다. Safe-area inset은 mobile root가 한 번만
소유한다.

## 6. Design tokens와 typography

Application chrome은 semantic `--ui-*` token을 사용한다. `--term-*`은 xterm,
terminal output과 기존 custom theme compatibility에만 사용한다. 새 component가
theme별 hex, local z-index ladder 또는 terminal token을 직접 사용하지 않는다.

필수 role은 canvas/surface/raised/inset/overlay/scrim, primary/secondary/muted/inverse
text, subtle/strong border, accent/on-accent, focus/info/success/warning/danger다.

- Type scale: 12, 13, 14, 16, 20px. 10/10.5px은 비필수 metadata, 26px은 desktop
  wordmark 전용이다.
- Space scale: 4, 8, 12, 16, 24, 32px과 pane gutter 14px.
- Radius: control 2/4/8px, card 12/14px, pill round.
- Control: compact 32px, comfortable 40px, touch minimum 44px.

Matrix display label과 wordmark는 bundled display font를 사용할 수 있지만 body,
Settings, help와 Korean은 local system UI stack을 사용한다. terminal, command, path와
diagnostic 값은 설정된 monospace를 사용한다. product text는 terminal font 선택의
영향을 받지 않는다.

Custom theme는 기존 persisted schema를 유지하고 runtime resolver가 semantic role의
contrast를 보정한다. provider color는 persisted schema를 늘리지 않고 theme class에서
파생한다.

## 7. Component와 overlay 계약

Button, IconButton, Dialog, ActionSheet, Menu, Popover, Tabs, Toast, Tooltip, FormControls와
Feedback primitives를 repository `ui/`에서 공유한다. 새 feature가 focus trap, Escape,
outside click, disabled, loading과 live-region 의미를 복제하지 않는다.

- 한 modal layer만 top layer로 상호작용하고 background는 inert/aria-hidden 처리한다.
- 닫기는 안전한 경우 Escape/Android Back을 지원하고 stable invoker로 focus를 돌린다.
- 위험 action은 명시적 label과 안전한 초기 focus를 사용한다.
- Toast는 action의 유일한 오류 설명이 될 수 없으며, 복구 가능한 오류는 originating
  surface에 남는다.
- loading, empty, offline, permission denied, unsupported와 stale data를 같은 skeleton
  또는 0 값으로 표현하지 않는다.

## 8. Localization과 접근성

지원 locale은 Korean과 English이며 effective locale은 desktop menu, renderer와 mobile
UI에 하나의 결정 규칙으로 적용된다. provider·protocol·product name은 번역하지 않되
문장과 accessible label 안에서 자연스럽게 조합한다. 하드코딩 product string과 혼합
locale은 결함이다.

- 본문 text contrast는 최소 4.5:1, component boundary와 focus indicator는 최소 3:1이다.
- 의미를 color, glow, animation이나 icon 하나에만 의존하지 않는다.
- keyboard focus order는 visual order를 따르고 모든 action은 visible focus를 가진다.
- reduced motion은 boot, ticker, pulse, rollbar와 decorative transition을 중지한다.
  terminal output, remote video와 사용자가 요청한 외부 content는 decorative motion으로
  취급하지 않는다.
- status 변화는 필요한 경우 하나의 polite live region을 사용하고 fps, cursor, timer
  tick을 반복 announce하지 않는다.
- 200% text zoom과 screen reader label에서도 primary flow를 완료할 수 있어야 한다.

## 9. 주요 상태 계약

- **Boot:** 실제 phase만 표시하고 reduced motion 또는 disabled preference에서 즉시
  skip한다. skip 입력을 PTY로 누출하지 않고 timer를 정리한다.
- **Monitor:** 마지막 실제 sample과 collection scope를 표시한다. unsupported/capture
  failure를 건강한 0으로 만들지 않고 visible할 때만 수집한다.
- **Remote/Pairing:** bridge off, VPN 없음, service 없음, idle, busy와 active를 구분한다.
  QR expiry/redeem과 device roster에서 stale generation을 복원하지 않는다.
- **OpenClaw:** missing CLI, stopped, unreachable, timeout과 running을 구분한다. Chat의
  external body는 pixel oracle에서 제외하지만 EZTerminal chrome과 상태는 포함한다.
- **Paste/Risky close:** 위험 이유를 유지하고 Cancel을 안전 focus로 둔다. 최종 상태
  비교가 실패하면 아무것도 실행하지 않는다.
- **Explorer:** root, empty folder, non-repository와 Git unavailable을 구분하며 breadcrumb,
  full path, Up과 folders-first ordering을 유지한다.
- **PC Control:** unavailable, starting, active, reconnecting, busy와 error를 구분한다.
  input mode, monitor, sticky modifier와 controller 상태는 color 외의 표현을 가진다.

## 10. Agent UI 계약

Agent content 순서는 Attention, Projects, Active, Recent다. Global launch는 Agent와
location이 모두 비어 있고, project의 New chat은 project만 preselect한다. Desktop은
repository `Dialog`, Android는 `MobileActionSheet`를 사용하지만 같은 validation과
Launch/Cancel 의미를 가진다.

Location은 saved/observed project와 직접 host folder를 제공한다. 선택 또는 취소만으로
project를 쓰지 않으며 성공한 direct-directory launch만 unpinned observed project가
된다. Codex/Claude는 primary/additional roots를 받고 generic launcher는 primary만 사용하며
무시되는 root 수를 실행 전에 알린다.

History row, desktop history panel과 Android sheet는 provider text label과 3px start rail을
사용한다. Codex는 dark/matrix `#48d7c8`, light `#006b64`, high contrast `#00ffff`를,
Claude는 각각 `#e58a6b`, `#9a3f28`, `#ff9b7a`를 기준으로 contrast 보정한다. Provider
의미를 color에만 의존하지 않고 live status surface는 provider-neutral로 유지한다.

### 10.1 Desktop rail 우선순위와 프로젝트 세션 기록

Desktop Activity Rail의 상단 순서는 Agents, Monitor, Remote, Files(Explorer), OpenClaw다.
Files는 네 번째 위치를 유지하며 OpenClaw가 숨겨져도 앞선 세 destination의 순서는
압축하지 않는다. Settings는 계속 하단에 고정한다. keyboard focus 순서는 이 시각 순서와
같고 tooltip, localized accessible name과 selected state 계약은 3.3을 따른다.

프로젝트의 이전 세션은 프로젝트 행의 disclosure/accordion으로 펼치지 않는다. 검토한
방향은 (1) 기존 인라인 accordion 유지, (2) 프로젝트 `…` 메뉴의 **Session history**가
Agent sidebar 내부 전용 하위 화면을 여는 방식, (3) 같은 메뉴에서 modal을 여는 방식이다.
사용자가 선택한 방향은 2다. 프로젝트 목록의 밀도를 유지하면서도 기록 탐색에 전체
sidebar 높이를 쓸 수 있고, modal focus layer를 추가하지 않는 대신 목록으로 돌아가는
명시적인 Back action이 필요하다.

Session history 메뉴 항목은 프로젝트별 단일 진입점이다. 하위 화면은 프로젝트 이름,
Back, provider-labelled session row와 pagination을 제공한다. loading/long-running은 기존
목록을 지우지 않고 busy 상태를 표시하며, empty, load error와 retry를 서로 구분한다.
세션 선택은 기존 read-only history panel을 열고, change review action도 기존 동일한
handler를 사용한다. Back, session row, retry와 더 보기는 keyboard와 pointer로 동일하게
동작하고 icon-only action은 localized accessible name을 가진다. offline과 permission은
로컬 history 읽기에 별도 의미가 없어 not applicable이며, validation과 cancellation도
사용자 입력이나 장기 mutation이 없으므로 not applicable이다.

새 asset, dependency, font 또는 token은 추가하지 않는다. repository `Menu`, `MenuItem`,
`IconButton`, Lucide icon과 기존 `agent-history-*` component/token을 재사용한다. normative
외부 mock은 없으며 실제 component test가 rail DOM 순서, accordion 부재, menu 진입,
Back, loading/empty/error/pagination을 검증한다. Storybook/visual lane은 repository에 이미
구성된 기존 Agent surface snapshot을 oracle로 사용하고, 이 계약과 불일치할 때 snapshot을
자동으로 정답 취급하지 않는다. 미해결 제품 결정은 없다.

## 11. PC Control UI 계약

Mobile page는 explicit Start 뒤에만 video/input을 연다. Toolbar는 input mode, monitor,
keyboard/IME, special keys, clipboard와 Disconnect를 gesture 없이도 제공한다. Android
Back은 sheet, overflow, remote page 순서로 닫고 기존 mounted terminal로 돌아간다.

Desktop banner와 tray는 active controller가 있을 때만 나타나며 device와 local
Disconnect를 제공한다. 시작 시 terminal focus를 훔치지 않고 release 뒤 즉시 사라진다.
Native 오류 remediation은 Remote panel에 남기고 stale active banner를 유지하지 않는다.

## 12. 시각·접근성 검증

`DesktopHandoff.stories.tsx`는 manifest의 14개 표면에 실제 product component와
deterministic adapter를 사용한다. 각 handoff story는 axe와 1920 reference를 가지며
Korean/English product content를 검증한다.

Pairwise visual matrix는 다음을 포함한다.

- 800×600/1024×720 overlay와 1200×800/1440×900 reflow
- 100%/150% scale의 shell, sidebar와 dialog
- Matrix, Light, Dark, High Contrast
- reduced-motion boot, ticker, pulse, rollbar와 transition
- mobile 360×800, 412×915, 600×960과 landscape 핵심 화면

Snapshot 갱신은 reference와 side-by-side로 검토하고 adaptive layout, external content,
보안 또는 truthful-data 차이만 manifest 예외로 기록한다. 문서 정리만을 이유로 snapshot을
갱신하지 않는다.

## 근거 소스

- [`src/renderer/App.tsx`](../../src/renderer/App.tsx)
- [`src/renderer/workbench/`](../../src/renderer/workbench/)
- [`src/renderer/ui/`](../../src/renderer/ui/)
- [`src/renderer/styles/ui-tokens.css`](../../src/renderer/styles/ui-tokens.css)
- [`src/renderer/i18n/resources.ts`](../../src/renderer/i18n/resources.ts)
- [`src/renderer/feature-loader.tsx`](../../src/renderer/feature-loader.tsx)
- [`src/shared/resource-profile.ts`](../../src/shared/resource-profile.ts)
- [`mobile/src/MobileWorkbenchCoordinator.tsx`](../../mobile/src/MobileWorkbenchCoordinator.tsx)
- [`mobile/src/MobileSettingsView.tsx`](../../mobile/src/MobileSettingsView.tsx)
- [`mobile/src/MobileTabBar.tsx`](../../mobile/src/MobileTabBar.tsx)
- [`mobile/src/mobile-shell.css`](../../mobile/src/mobile-shell.css)
- [`docs/ux/reference/desktop-handoff/manifest.json`](reference/desktop-handoff/manifest.json)

## 검증

- [`scripts/guard-desktop-handoff.mjs`](../../scripts/guard-desktop-handoff.mjs)
- [`src/renderer/workbench/DesktopHandoff.stories.tsx`](../../src/renderer/workbench/DesktopHandoff.stories.tsx)
- [`e2e/workbench-shell.spec.ts`](../../e2e/workbench-shell.spec.ts)
- [`visual/storybook.visual.spec.ts`](../../visual/storybook.visual.spec.ts)
- [`test/desktop-handoff-guard.test.ts`](../../test/desktop-handoff-guard.test.ts)
- [`mobile/src/MobileWorkbenchCoordinator.test.tsx`](../../mobile/src/MobileWorkbenchCoordinator.test.tsx)
- [`mobile/src/MobileUiPreferencesProvider.test.tsx`](../../mobile/src/MobileUiPreferencesProvider.test.tsx)

이전 전체 규격과 완료 addendum은
[`docs/archive/design/frontend-design.md`](../archive/design/frontend-design.md)에 보존한다.

## 13. Agent Project 통합 작업 공간

이 절은 Agent Project의 유일한 canonical UX 계약이며, 이전의 Code/Changes/Working
tree 목적지, 별도 CodeFile/CodeDiff editor, preview tab, 코드 질문 흐름에 관한
결정을 모두 대체한다.

### 13.1 제품 표면, 사용자와 목표

대상은 EZTerminal Electron desktop에서 Agent Project를 열어 프로젝트 파일과 실행
중인 PTY를 함께 다루는 사용자다. 프로젝트 진입 직후 별도 학습이나 중간 화면 없이
파일 트리가 보여야 하고, 한 번의 파일 선택으로 중앙 작업 영역에서 실제 파일 전체를
읽을 수 있어야 한다. 변경은 별도 문서가 아니라 같은 파일에 적용되는 inline 비교
렌즈다. 이번 범위는 read-only 탐색이며 편집·저장, LSP, stage, revert, commit,
모바일 구현은 포함하지 않는다.

### 13.2 검토한 방향과 선택

1. **Agent sidebar를 Project Explorer로 승격 — 선택.** 기존 project 진입과 sidebar
   shell을 재사용하면서 프로젝트 진입 즉시 tree를 보여 준다. wide에서는 tree와
   editor/PTY를 함께 보고, narrow에서는 tree drawer를 닫아 작업 영역을 확보한다.
2. **전용 project column.** 정보 구조는 가장 명시적이지만 application shell과 layout
   persistence 변경 범위가 크고 기존 Agent 진입과 중복된다.
3. **Dockview-native tree panel.** 자유로운 재배치는 가능하지만 tree가 또 하나의
   닫을 수 있는 문서가 되어 프로젝트의 안정적인 출발점이라는 의미가 약해진다.

선택 방향의 핵심 tradeoff는 narrow에서 tree와 파일을 동시에 보지 않는 대신,
파일 선택 후 즉시 editor로 전환하고 Files control로 같은 tree 상태를 다시 여는
것이다.

### 13.3 정보 구조와 실제 클릭 흐름

- Agents에서 프로젝트 이름을 선택하면 같은 sidebar가 Project Explorer로 바뀌고
  파일 tree를 즉시 표시한다. Files/Changes/Working tree/Sessions 내부 tab은 없다.
- header에는 Back, 프로젝트 이름과 경로, 하나보다 많은 실제 checkout이 있을 때만
  보이는 작업 위치 selector, New Chat과 Manage만 둔다.
- tree와 파일명·본문 search는 같은 project-relative path를 가리킨다. 파일을 한 번
  click하거나 Enter/Space로 활성화하면 일반 read-only tab이 열린다. preview,
  double-click pinning, Keep Open은 없다.
- PTY path, PTY change summary, Agent Session file-change도 같은 open command를
  사용한다. 이미 열린 path이면 새 tab을 만들지 않고 그 tab과 요청 위치를 재사용한다.
- Agent session 목록과 PTY/Agent panel은 기존 surface에 남는다. 프로젝트 tree를
  Sessions view로 바꾸지 않는다.
- 등록 프로젝트 밖의 image/PDF/binary preview는 기존 generic preview 규칙을 유지한다.
  등록 프로젝트의 text path는 generic preview로 우회하지 않는다.

### 13.4 문서 정체성, 비교 렌즈와 tree 표현

문서의 durable identity는
`projectId + rootId + workspaceId + canonical project-relative path`다. Windows
path casing은 main process가 canonical equality key로 정규화한다. repository,
revision, comparison source, reveal location과 view mode는 tab identity가 아니며
layout에 저장하지 않는다.

기본 렌즈는 `HEAD ↔ 현재 checkout` 전체 변경이다. 직접 파일 열기와 tree 재선택은
항상 이 렌즈로 돌아간다. Agent Session 링크만 exact `historyId + turnId` 렌즈를
같은 tab에 일시 적용하고 닫을 수 있는 `Agent turn` provenance chip을 보여 준다.
chip을 닫으면 현재 변경으로 복귀한다. staged/branch/commit catalog와 selector는
제공하지 않는다.

tree는 실제 entry와 Git 상태를 합쳐 같은 node에 `M/A/D/R`, `+N -M`을 표시한다.
삭제된 path와 rename의 이전 path는 virtual node로 나타내고, nested repository,
untracked 파일과 첫 commit 이전 repository에서도 정확한 상태를 계산한다. 색만으로
상태를 구분하지 않는다.

### 13.5 editor와 inline diff

파일 surface는 하나의 `project-editor`다. text 파일은 1 MiB 이하일 때 첫 줄부터
마지막 줄까지 자르거나 unchanged region을 접지 않고 표시한다. 변경된 파일이면 같은
Monaco surface에서 inline diff를 자동 표시한다. 사용자는 전체 파일 보기, 현재 파일
보기, 미리보기 같은 전환 button을 누르지 않는다.

toolbar는 breadcrumb, optional Agent-turn provenance, read-only 상태, Find, Go to
Line, 이전/다음 변경과 Refresh만 포함한다. Ask about code, Add lines, Add with
snippet, question composer와 reference 수집·전송 control은 없다.

provider의 안전한 before model을 만들 수 없으면 현재 파일 전체를 유지하고 검증된
record를 같은 surface의 view zone에 표시한다. 현재 파일도 없으면 같은 path tab에서
record-only 또는 deleted 상태를 정직하게 표시한다. 과거 내용을 현재 파일인 것처럼
추정하지 않는다.

### 13.6 wide와 narrow layout

`1024 CSS px` 이상 wide:

```text
┌──────────┬─────────────────────────────────────────┐
│ Activity │ Project Files 280–400 px                │
│ rail     ├───────────────────────────────┬─────────┤
│          │ editor, available height 68%  │ tabs    │
│          ├───────────────────────────────┴─────────┤
│          │ existing PTY/Agent topology, 32%        │
└──────────┴─────────────────────────────────────────┘
```

editor와 아래 PTY 영역의 비율은 resizable이며, 기존 여러 PTY group의 topology와
panel instance를 유지한다. file open과 layout 변경은 terminal focus를 빼앗지 않는다.
사용자가 editor tab을 명시적으로 활성화할 때만 editor에 focus를 준다.

`1024 CSS px` 미만 narrow:

```text
┌────────────────────────────┐
│ Files drawer (on demand)   │
├────────────────────────────┤
│ Dockview: Editor | PTY     │
│ active surface fills body  │
└────────────────────────────┘
```

Project Explorer는 focus-trapped drawer이며 파일 활성화 후 자동으로 닫힌다.
editor와 PTY는 Dockview tab으로 전환하고 PTY renderer는 계속 mounted 상태를
유지한다. breakpoint 왕복과 project 종료 시 panel node를 재생성하지 않고 원래
group membership과 크기를 복원한다. sidebar를 닫았다 다시 열어도 active project,
expanded folder, selection과 search query를 유지한다.

### 13.7 작업 위치와 권한

project에 실제 checkout이 하나면 작업 위치 selector를 숨긴다. main 또는 EZTerminal
managed worktree는 즉시 읽을 수 있다. 외부 worktree는 exact canonical path, branch와
Git identity를 보여 준 뒤 사용자 승인을 받아 read-only로 연다. PTY나 Agent 링크가
작업 위치를 조용히 전환하지 않는다. 승인 취소, 경로·repository identity 변경 또는
project 제거 시 저장된 승인을 재사용하지 않는다.

### 13.8 상태 계약

| 상태 | 같은 workspace 안의 표현 |
| --- | --- |
| loading/long-running | tree 또는 editor region에 `aria-busy`, 기존 내용 유지, stale request 취소 |
| empty project/folder/search | 대상과 다음 행동을 구체적으로 설명하며 가짜 file을 만들지 않음 |
| unchanged text | 전체 read-only file, diff decoration 없음 |
| M/A/D/R | 전체 문맥 inline diff 또는 검증된 deleted/record-only 상태 |
| binary/1 MiB 초과 | 같은 path tab의 명시적인 unavailable 상태, 일부 내용 미리보기 없음 |
| permission/external worktree | main이 검증한 승인 surface, 취소 가능 |
| stale/missing | 현재 revision과 불일치를 설명하고 안전한 Refresh 제공 |
| comparison failure | 읽을 수 있는 현재 파일은 유지하고 provenance 가까이에 retry 가능한 warning |
| offline | 모든 source가 local-only이므로 not applicable; network fetch를 시작하지 않음 |
| validation | 편집·저장이 범위 밖이므로 not applicable |
| success | tree selection, tab, breadcrumb와 comparison lens가 같은 path를 표시 |

### 13.9 component, token과 입력 계약

기존 Monaco, lucide-react, project token, button, input, tree와 SidebarShell
primitive를 재사용한다. 새 dependency, font, image asset, network resource나
telemetry를 추가하지 않는다. component taxonomy는 App-owned project state,
Project Explorer tree/search, document open coordinator, `project-editor`,
comparison provenance, worktree approval, layout coordinator로 제한한다.

tree는 roving focus, Arrow/Home/End, Enter/Space를 지원하고 search result는
line/column까지 editor에 전달한다. breadcrumb와 긴 path는 줄임표와 전체 accessible
name을 함께 제공한다. 모든 icon-only control에는 label과 tooltip이 있고 focus-visible
outline을 유지한다. M/A/D/R와 증감 수치는 visible text와 screen-reader name에 모두
포함한다. target은 WCAG 2.1 A/AA이며 keyboard-only, screen reader label, contrast,
focus order와 reduced-motion을 관찰 가능하게 검증한다.

### 13.10 lifecycle 불변 조건

project 진입, 파일 열기, wide/narrow 전환, sidebar open/close와 project 종료 동안
PTY process, session id, output, 실행 중 command, input draft, selection, scroll,
active panel과 focus를 잃지 않는다. layout coordinator는 기존 Dockview node를
이동하며 `fromJSON` 또는 panel recreation을 사용하지 않는다. project editor의
저장 descriptor에는 identity만 남기고 content, revision, lens, reveal과 preview
상태는 저장하지 않는다. legacy pinned `code-file`/`code-diff` descriptor는 같은
path의 `project-editor`로 migration하고 legacy preview는 복원하지 않는다.

### 13.11 시각 QA와 증거

normative mock 또는 외부 design file은 없다. 이 문서와 실제 Storybook story가
규범이며, story가 계약과 달라지면 문서를 자동으로 따라 바꾸지 않는다. asset
provenance는 기존 repository-owned icon/token뿐이며 추가 license 검토 대상은 없다.

- Storybook integrated story는 `tree + full-file inline editor + live PTY`를
  1440×900 wide와 800×600 narrow에서 보여 준다.
- loading, empty, M/A/D/R, deleted, record-only, permission과 error 상태를 component
  test와 story에서 검증한다.
- project-local visual snapshot은 available height 채움, 상하단·수평 clipping 부재,
  drawer 전환과 별도 Changes/질문 UI 부재를 확인한다.
- Electron E2E는 tree/search/PTY/Agent 진입의 same-tab reuse, exact reveal,
  breakpoint 왕복과 PTY lifecycle 불변 조건을 실제 runtime에서 확인한다.
- lint, typecheck, unit/component test, Storybook/visual, ordinary `pnpm e2e`가 gate다.
  release performance benchmark는 이 설계의 검증 lane이 아니다.

미해결 제품 결정은 없다. 구현 중 발견되는 filesystem/Git 한계는 기능을 추정하거나
새 Source Control UI를 추가하는 근거가 아니며, 같은 path의 명시적인 unavailable
상태로 처리한다.

## 14. Explorer 파일·폴더 시각 계층

이 절은 desktop의 일반 Files Explorer와 Agent Project Explorer가 공유하는 entry
표현 계약이다. 대상은 큰 폴더에서 경로와 Git 변경을 함께 훑는 사용자이며, 별도
학습이나 view 전환 없이 폴더·파일 종류·계층을 즉시 구분하는 것이 목표다. Quick
Open, editor tab, breadcrumb와 mobile surface는 이 계약의 범위가 아니다.

검토한 방향은 (1) 폴더 위계와 선별된 Lucide file icon을 함께 강화하는 방식,
(2) VS Code file-icon package를 추가하는 방식, (3) 기존 monochrome icon을 유지하고
간격만 조정하는 방식이다. **방향 1을 선택한다.** 방향 2는 새 dependency와 과도한
색상 vocabulary를 만들고, 방향 3은 현재의 파일·폴더 구분 문제를 충분히 해결하지
못한다. Lucide와 semantic `--ui-*` token만 사용하며 새 image, font, network asset,
telemetry 또는 persisted theme role을 추가하지 않는다.

- folder는 `Folder`와 `FolderOpen`, 낮은 opacity의 fill, restrained accent와 굵기
  650의 이름을 사용한다. Project tree의 expanded folder는 옅은 surface와 16px
  간격의 semantic border indentation guide를 가진다.
- file은 case-insensitive basename과 extension으로 판별한다. README/CHANGELOG/LICENSE,
  package manifest, lockfile, Docker/Make/Git/editor/env/config file을 extension보다 먼저
  판별하고, `test`/`spec` 이름을 일반 code extension보다 먼저 판별한다.
- icon shape은 code, web/style, terminal script, JSON, config, document, test, data,
  image, archive와 generic fallback을 구분한다. 색 category는 folder/accent,
  code/info, config/warning, document/subdued-info, test/success, media와 generic/muted로
  제한한다. danger는 Git delete/conflict 전용으로 남긴다.
- Project tree의 기존 28px row, 일반 Explorer의 compact padding, selection background,
  focus outline, Git `M/A/D/R`와 diffstat를 유지한다. selection과 Git status가 file-type
  color보다 강한 signal이어야 한다.
- icon은 decorative `aria-hidden`이다. Project folder는 `aria-expanded`로, 일반 Files
  list는 localized visually-hidden file/folder text로 종류를 전달한다. 의미는 색 하나에
  의존하지 않는다. create/rename, loading, empty, error와 parent entry에서도 기존
  keyboard 및 pointer 동작을 유지한다.

외부 normative mock은 없다. `ProjectWorkspaceComposition`의 wide/narrow story와
`DesktopHandoff` Explorer story가 visual oracle이며, 대표 folder/code/config/document/
test/media/generic entry와 High Contrast를 포함한다. resolver unit test, 두 Explorer의
component test, Storybook axe/visual, lint, typecheck와 ordinary `pnpm e2e`가 검증 gate다.
release performance benchmark는 이 변경의 검증 lane이 아니다. 미해결 제품 결정은 없다.
