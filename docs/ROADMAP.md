# EZTerminal Roadmap

> Current for the **v1.0.36 release candidate** (2026-08-14).
> 이 문서는 현재 제품 방향과 아직 구현되지 않은 후보만 기록한다. 현재 시스템 구조와
> 변경 계약은 [`architecture.md`](architecture.md), 완료 과정은
> [`archive/`](archive/README.md), 출시 이력은 버전별 release 문서가 소유한다.

## 제품 방향

EZTerminal은 기존 셸을 감싸는 terminal에 머물지 않고 typed row와 block UI를 제공하는
structured-data shell이다. Built-in은 filter/sort 가능한 값을 만들고 일반 프로그램,
interactive CLI와 full-screen TUI는 PTY/xterm으로 실행한다.

지원 제품은 다음과 같다.

- Windows 10 22H2 또는 Windows 11 x64 desktop
- Android 10(API 29) 이상의 companion
- 사용자가 선택한 Tailscale, WireGuard 등 신뢰 VPN을 통한 원격 접근

## 현재 기능

### 셸과 terminal

- Typed built-in, pipeline, variable, 환경, history와 가상화 결과 table
- 독립 tab·split·분리 창, layout preset과 재시작 영속성
- ConPTY/xterm, bounded output retention, cancel, byte backpressure, search, link,
  Unicode와 WebGL fallback
- TOFU host-key 검증 SSH, loopback local forward와 안전한 attach 제한
- 별도 utility process의 사용자 JavaScript script host

현재 계약:

- [`architecture.md`](architecture.md)
- [`terminal-runtime.md`](design/terminal-runtime.md)
- [`workbench-lifecycle.md`](design/workbench-lifecycle.md)
- [`cli-parity-manual-checklist.md`](release/cli-parity-manual-checklist.md)

### Workbench와 통합

- Adaptive desktop workbench, Explorer, Quick Open/Command Center, theme·Matrix CRT,
  Settings, telemetry와 optional packet capture
- 기능별 lazy module, intent/idle preload, 격리된 Retry/Close와 desktop·Android의
  Balanced/Low resource/High responsiveness profile
- Safe preview, Git worktree, agent attention/history/launch와 OpenClaw lifecycle/chat
- Renderer/interpreter recovery, bounded persistent state와 packaged native-module guard

현재 계약:

- [`DESIGN.md`](../DESIGN.md)
- [`frontend-design.md`](ux/frontend-design.md)
- [`external-integrations.md`](design/external-integrations.md)

### Android와 PC Control

- 인증·재연결·lease·보안 credential·file transfer를 갖춘 원격 terminal
- 신뢰 VPN에 묶인 WebRTC, 선택 모니터 GDI/OpenH264 영상, trackpad/direct touch,
  keyboard/IME, 별도 설정 없는 Bluetooth keyboard/mouse와 명시적 text clipboard
- Native service와 active-session agent가 준비되지 않으면 PC Control capability를
  fail closed하되 terminal remote access는 유지

현재 계약:

- [`remote-terminal.md`](design/remote-terminal.md)
- [`remote-desktop.md`](design/remote-desktop.md)
- [`validation-policy-1.0.36.md`](release/validation-policy-1.0.36.md)

## 유지보수 계약

- `release/version.json`이 desktop, mobile, Android, native host와 remote protocol
  version의 기준이다.
- 현재 release 검증 정책의 저장소 경로는
  `docs/release/validation-policy-1.0.36.md`이다.
- Desktop과 Android release artifact는 같은 clean Git SHA에서 만들고
  [`release/README.md`](release/README.md)의 gate를 통과한다.
- 일반 개발 검증은 `pnpm e2e`를 사용한다. release performance benchmark는 사용자가
  성능 측정을 명시적으로 요청한 경우에만 실행한다.
- `pnpm profile:runtime`은 임시 profile에서 startup·feature chunk·working set을 보는
  개발 진단이며 `test-results/` 결과는 release evidence나 회귀 gate가 아니다.
- Android 장기 signing material은 Git 밖에 둔다. `.release-secrets/`는 workspace
  정리로 삭제하지 않는다.
- 활성 계약과 코드가 어긋나면 회귀 또는 의도된 변경을 먼저 결정하고 코드·문서·검증을
  함께 갱신한다.

## 남은 후보

다음 항목은 구현 약속이 아니라 별도 제품·보안 결정이 필요한 후보이다.

1. **Release 운영:** Windows code signing 활성화, store/background installation 정책,
   physical-device release coverage 확대
2. **Platform 범위:** 현재 unit seam만 있는 macOS/Linux 경로의 실기기 검증과 packaging
3. **PC Control 확장:** HDR, lock screen, UAC secure desktop, Software SAS와
   Ctrl+Alt+Delete. 권한·service 경계를 먼저 별도로 설계해야 한다.
4. **AI 도움:** data-egress와 provider 정책이 승인된 뒤의 natural-language command help

## 문서 지도

- 제품·build 개요: [`README.md`](../README.md)
- 현재 시스템 구조: [`architecture.md`](architecture.md)
- 현재 visual design 계약: [`DESIGN.md`](../DESIGN.md)
- 현재 subsystem 계약: [`design/`](design/)
- 현재 UX 계약: [`ux/frontend-design.md`](ux/frontend-design.md)
- 현재 release 절차: [`release/README.md`](release/README.md)
- 출시 이력: [`CHANGELOG.md`](../CHANGELOG.md)와 버전별 `release/` 문서
- 완료 계획·조사: [`archive/`](archive/README.md)
