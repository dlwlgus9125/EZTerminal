# EZTerminal 1.0.3

기존 디자인과 사용자 흐름을 유지하면서 장시간 실행, 대용량 출력, 원격 연결,
종료·복구 경로를 상용 배포 후보 수준으로 안정화한 패치 릴리스입니다.

## 안정화와 운영 품질

- 구조화 출력과 PTY 스크롤백에 명시적인 메모리·디스크 보존 한도를 적용했습니다.
  큰 구조화 결과는 bounded spill 저장소로 넘기고 메모리 cache는 LRU로
  비웁니다. 세션이나 앱의 디스크 한도에 도달하면 추가 생산을 명시적인 capacity
  오류로 중단하며, spill 파일은 runtime 수명주기에 맞춰 정리합니다.
- 실행, 모바일 run port, 권한 접근, workbench 저장, 데스크톱 runtime과 모바일
  PC Control 표시 로직을 좁은 adapter/interface 경계로 분리했습니다. 기존 UI
  구조와 클래스, WebSocket 프로토콜, stdout 형식은 유지합니다.
- 렌더러 오류 경계와 crash recovery를 추가하고, 종료·취소·재연결 중 stale
  completion과 자원 누수를 차단했습니다.
- Node/pnpm/Rust/Android 도구 버전, lock과 검증 메타데이터를 고정하고,
  JavaScript·Rust 감사와 CycloneDX SBOM을 릴리스 게이트에 포함했습니다.
- 같은 Windows 호스트에서 5회 워밍업 후 25회 측정하는 성능 비교, p95 회귀
  5% 한도, 지정 병목 15% 개선, 취소 p95 3초 이하를 RC 승인 기준으로
  명시했습니다. 실제 승인은 동일 SHA의 보고서가 이 기준을 통과해야 합니다.

## 터미널과 Codex 입력

- 직접 실행한 Codex에서 선택 영역이 없을 때 `Ctrl+C`와 `Ctrl+D`가 세션을
  종료하지 않도록 보호합니다.
- `Esc`는 현재 Codex 작업 중단에 그대로 사용하며, `/exit`, `/quit`, 명시적인
  **강제 종료**는 유지합니다.
- 선택 영역이 있으면 `Ctrl+C`가 일반 복사로 동작합니다.
- 이미지가 포함된 클립보드의 `Ctrl+V`는 Codex에 전달해 이미지 첨부를
  처리합니다. EZTerminal은 임시 이미지 파일이나 경로를 만들지 않습니다.
- `Ctrl+Shift+V`와 `Shift+Insert`는 텍스트 붙여넣기를 강제하고,
  `Ctrl+Insert`는 선택 영역을 복사합니다.
- 여러 줄 또는 5 KiB 초과 텍스트 붙여넣기 경고를 추가했으며 두 경고를
  설정에서 각각 끌 수 있습니다.
- 앱 단축키 충돌을 정리해 `Ctrl+P`와 `Ctrl+F`를 터미널 프로그램에 전달하고,
  명령 모드와 xterm 검색은 각각 `Ctrl+Shift+P`, `Ctrl+Shift+F`로 사용합니다.
- 일반 PTY와 모바일의 기존 제어키 동작은 변경하지 않았습니다.

## PC Control 상태

- Windows 빌드에는 PC Control이 기본 포함됩니다. remote bridge와 신뢰한 VPN,
  설치된 host service가 준비된 경우에만 capability를 광고하며 제어 시작에는
  활성 세션 agent handshake가 추가로 필요합니다. 어느 하나라도 실패하면
  터미널 원격 기능을 유지한 채 PC Control만 fail closed로 비활성화합니다.
- LocalSystem 서비스가 로컬 transport 신원, 단일 controller lease, 활성
  Windows 세션과 세션 agent 수명주기를 관리합니다.
- 1.0.3의 실제 프레임 캡처·OpenH264 인코딩과 `SendInput` 주입은 일반 사용자
  transport에 남아 있습니다. 잠금/UAC secure desktop과 Ctrl+Alt+Delete는
  지원하지 않으며 Software SAS capability는 항상 false입니다.

## 지원과 검증 범위

- 지원 대상: Windows 10 22H2/Windows 11 x64, Android 10(API 29) 이상
- 이번 후보의 검증 증거: 현재 Windows 호스트, Android API 29/API 35
  에뮬레이터
- 미검증: 관리자 권한의 물리 Windows 서비스 설치·제거, Windows 에디션·정책
  조합, 물리 Android/OEM/TalkBack, 실제 VPN, 다중 모니터·HDR

서명 인증서·키스토어 운영, GitHub Release/Play Store 게시, AAB와 자동
업데이트는 이번 안정화 범위에 포함되지 않습니다. Windows 빌드는 계속
Authenticode 미서명이므로 SmartScreen 경고가 표시될 수 있습니다. Android
릴리스 APK는 게시 전에 별도의 보호된 장기키 서명 절차를 통과해야 합니다.
자세한 판정 기준은 [1.0.3 검증 정책](validation-policy-1.0.3.md)을 확인하세요.

## 다운로드

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10(API 29) 이상: `EZTerminal-Android-1.0.3-vc24.apk`
- 무결성 검증: `SHA256SUMS.txt`

Windows와 Android 업데이트는 GitHub Release를 통한 수동 설치 방식입니다.
