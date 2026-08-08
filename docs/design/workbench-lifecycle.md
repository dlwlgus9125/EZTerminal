# Workbench 수명과 영속성 계약

> 문서 상태: **활성 규범 계약**
>
> 범위: Dockview 패널, 셸 세션 표면, 레이아웃·프리셋 저장, 분리 창, 닫기와
> workspace 교체 transaction.

## 현재 계약

Desktop workbench는 패널 배치와 셸 세션 수명을 분리한다. Dockview는 레이아웃 UI
adapter이고, `WorkbenchCoordinator`가 패널 ID, transaction generation, 저장 순서와
활성 패널 전환을 소유한다. `SessionMirroringCoordinator`와 main의
`SessionSurfaceAuthority`는 하나의 셸 세션을 여러 표면에서 관찰하거나 이동할 때의
권한을 소유한다.

## 레이아웃 저장

- Renderer는 Dockview JSON을 직접 파일에 쓰지 않는다. preload를 거쳐 main의
  `LayoutStore`에 전달한다.
- 저장 입력은 [`layout-schema.ts`](../../src/shared/layout-schema.ts)의 Zod schema와
  sanitizer를 통과한다. 현재 `LAYOUT_SCHEMA_VERSION`은 1이다.
- Main은 userData 아래에 원자적으로 저장하고 크기·panel count·문자열 길이·알 수 없는
  panel type을 제한한다. 손상된 저장값은 quarantine하고 안전한 기본 레이아웃으로
  복구한다.
- layout change는 debounce하며 이전 비동기 저장이 새 transaction 뒤에 도착해 덮어
  쓰지 못하도록 coordinator가 순서를 보장한다.
- named preset과 마지막 레이아웃은 같은 검증 envelope를 사용한다.

영속 대상은 panel 구조, 제목, renderer preference와 지원되는 표시 설정이다. 실행 중
PTY, 명령 결과, MessagePort, 비밀 프롬프트와 runtime object를 Dockview params에 넣거나
직렬화하지 않는다.

언어, density, effect intensity와 resource profile은 layout/preset이 아니라 settings
snapshot에 저장한다. 기존 schema version 1 파일에서 resource profile이 없으면
`balanced`를 사용한다. Android는 별도 device-local envelope를 사용하며 v1/v2를 읽어
현재 v3 snapshot으로 다시 저장한다. 이 설정은 remote session이나 desktop으로
동기화하지 않는다.

## 복원과 workspace 교체

- 시작 복원은 schema 검증과 preflight를 끝낸 뒤 Dockview에 적용한다.
- 복원 중에는 자동 저장을 막고, 성공한 현재 generation에서만 저장을 다시 연다.
- 실패한 복원은 부분 적용 상태를 정상 상태로 저장하지 않는다. backup/default
  레이아웃으로 되돌리고 오류를 사용자에게 알린다.
- preset 적용과 workspace 교체는 준비, 권한 확보, 적용, commit/rollback 단계의 단일
  transaction이다. 동시 pane mutation이나 remote surface 변경과 경쟁하지 않는다.
- 패널에 저장된 session identity는 runtime 권한 증명이 아니다. 복원 시 broker와
  surface authority를 통해 유효 세션을 만들거나 채택한다.

## 패널과 분리 창

- terminal, Agent Session과 허용된 도구 panel만 layout schema에 등록한다.
- panel ID와 생성 제목은 workbench 전체에서 충돌하지 않는다.
- Dockview popout은 별도 renderer 표면이지만 session owner가 아니다. redock, 창 닫기,
  renderer crash가 셸 세션을 암묵적으로 중복 생성하지 않는다.
- `DesktopWindowManager`가 main window와 auxiliary window의 생성·bounds·preload·보안
  설정을 소유한다.
- pane mount/unmount는 `SessionMirroringCoordinator`의 lease를 획득·반납한다. 단순
  React unmount를 세션 파괴 신호로 사용하지 않는다.
- `PaneRegistry` 등록은 panel mount 수명과 같고 handle은 최신 pane ref로 위임한다.
  cwd·run-state 변경은 notification을 발행하며 header가 cwd를 polling하지 않는다.
  분 단위 open-age 표시는 시간 자체가 상태이므로 제한된 timer를 유지한다.

## Optional surface 로딩과 관찰 작업

- Terminal layer, Dockview와 activity navigation은 startup graph에 남는다. Sidebar
  destination과 rich preview는 기능 module 단위로 lazy load한다. 키보드 입력을 즉시
  소유해야 하는 Quick Open은 eager load한다.
- pointer enter/down 또는 keyboard focus는 intent preload로 취급한다. `balanced`는 idle,
  `high-responsiveness`는 eager preload도 허용하며 `low-resource`는 background preload를
  하지 않는다.
- module promise는 중복 요청이 공유한다. 실패한 promise는 cache에서 제거하고 해당
  surface가 Retry와 Close를 제공한다. terminal pane, draft와 session은 실패 경계 밖에
  남는다.
- visible surface의 목록·상태 refresh는 한 요청이 끝난 뒤 다음 timeout을 예약한다.
  hide/unmount/stop은 late completion이 새 timer를 만들지 못하게 한다. correctness와
  security timer는 resource profile의 영향을 받지 않는다.

## 닫기와 파괴

닫기는 UI 확인과 실제 mutation을 분리한다. `PaneLifecycleCoordinator`가 대상 표면,
active run과 위험도를 준비하고, 사용자가 승인한 뒤 main이 예상 run IDs와 현재 상태를
원자적으로 다시 비교한다.

- 상태가 달라지면 fail closed하고 새 확인 없이 세션을 파괴하지 않는다.
- 마지막 표면 닫기, popout 창 닫기, workspace 교체와 앱 종료는 동일한 guarded
  의미론을 사용한다.
- remote/mobile 표면이 남아 있으면 desktop pane 제거만으로 세션을 파괴하지 않는다.
- commit 후 뒤늦게 도착한 ACK가 새 세션이나 재사용된 ID를 지우지 못하도록 tombstone과
  correlation identity를 유지한다.

## UI 계약과의 경계

화면 배치, rail, Command Center, focus, 접근성과 토큰은
[`frontend-design.md`](../ux/frontend-design.md)가 소유한다. 이 문서는 그 UI가 호출하는
layout·session mutation의 의미만 소유한다. UI 변경이 Dockview params, session identity,
close guard 또는 persistence schema를 우회해서는 안 된다.

## 근거 소스

- [`src/shared/layout-schema.ts`](../../src/shared/layout-schema.ts)
- [`src/main/layout-store.ts`](../../src/main/layout-store.ts)
- [`src/main/desktop-window-manager.ts`](../../src/main/desktop-window-manager.ts)
- [`src/main/session-surface-authority.ts`](../../src/main/session-surface-authority.ts)
- [`src/renderer/workbench-coordinator.ts`](../../src/renderer/workbench-coordinator.ts)
- [`src/renderer/session-mirroring-coordinator.ts`](../../src/renderer/session-mirroring-coordinator.ts)
- [`src/renderer/pane-lifecycle-coordinator.ts`](../../src/renderer/pane-lifecycle-coordinator.ts)
- [`src/renderer/workspace-replacement-coordinator.ts`](../../src/renderer/workspace-replacement-coordinator.ts)
- [`src/renderer/pane-registry.ts`](../../src/renderer/pane-registry.ts)
- [`src/renderer/feature-loader.tsx`](../../src/renderer/feature-loader.tsx)
- [`src/renderer/async-poller.ts`](../../src/renderer/async-poller.ts)
- [`src/shared/resource-profile.ts`](../../src/shared/resource-profile.ts)

## 검증

- [`src/shared/layout-schema.test.ts`](../../src/shared/layout-schema.test.ts)
- [`src/main/layout-store.test.ts`](../../src/main/layout-store.test.ts)
- [`src/main/session-surface-authority.test.ts`](../../src/main/session-surface-authority.test.ts)
- [`src/renderer/workbench-coordinator.test.ts`](../../src/renderer/workbench-coordinator.test.ts)
- [`src/renderer/session-mirroring-coordinator.test.ts`](../../src/renderer/session-mirroring-coordinator.test.ts)
- [`src/renderer/pane-lifecycle-coordinator.test.ts`](../../src/renderer/pane-lifecycle-coordinator.test.ts)
- [`src/renderer/pane-registry.test.ts`](../../src/renderer/pane-registry.test.ts)
- [`src/renderer/feature-loader.test.ts`](../../src/renderer/feature-loader.test.ts)
- [`src/renderer/async-poller.test.ts`](../../src/renderer/async-poller.test.ts)
- [`e2e/layout-persistence.spec.ts`](../../e2e/layout-persistence.spec.ts)

과거 단일 창 전제와 구현 계획은
[`layout-persistence-design.md`](../archive/design/layout-persistence-design.md)에 보존한다.
