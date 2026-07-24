# EZTerminal 1.0.3 검증 정책과 잔여 위험

이 문서는 1.0.3 상용 배포 후보의 지원 대상과 실제 검증 증거를 분리한다.
지원 대상은 Windows 10 22H2/Windows 11 x64와 Android 10(API 29) 이상으로 유지한다.
그러나 이번 후보를 검증 완료라고 표현할 수 있는 범위는 현재 Windows 호스트와
Android API 29/API 35 에뮬레이터뿐이다. 지원 대상이라는 문구가 모든 OS 에디션,
장치, 정책 조합을 이번 후보에서 실증했다는 뜻은 아니다.

## 출시 차단 검증

- 현재 Windows 호스트의 clean packaged build와 데스크톱 회귀 테스트
- 같은 호스트와 전원 정책에서 수집한 기준/후보 성능 보고서 비교: 5회 워밍업 후
  25회 측정, 모든 p95 회귀 5% 이하, 12 MiB plain-output 보존 압력 병목 p95
  개선 15% 이상
- `gen-rows 100000000` 취소 지연 p95 3초 이하 및 최댓값 5초 미만
- Android API 29 및 API 35 에뮬레이터의 instrumentation/E2E
- 두 에뮬레이터는 snapshot을 불러오지 않는 cold boot로 시작하고, 제품 VPN
  바인딩을 완화하지 않은 채 하네스 전용 ADB reverse loopback을 사용한다.
  최초 인증 전 UI 제출과 실제 WebSocket 연결은 각각 정확히 1회여야 한다.
- API 35 에뮬레이터의 30분, 8세션, 20회 복구 soak
- JavaScript와 Rust 의존성 감사, SBOM, Gradle lock/검증 메타데이터
- 기존 시각 스냅숏, 접근성, Electron E2E와 packaged E2E

이 항목은 승인 기준이다. 동일 SHA에 결속된 `local-rc-report.json`이 모든
기준을 통과하기 전에는 문서만으로 상용 배포 검증이 완료된 것으로 간주하지 않는다.

## 알려진 기능 한계

- PC Control은 잠금되지 않은 대화형 데스크톱만 대상으로 한다. 잠금 화면과 UAC
  secure desktop의 화면 캡처·입력은 지원하지 않는다.
- LocalSystem 서비스는 로컬 호출자 신원, 단일 제어권 lease, 활성 Windows 세션,
  세션 에이전트 생성·감시를 소유한다. 현재 프레임 캡처·OpenH264 인코딩과 실제
  `SendInput` 주입은 일반 사용자 transport에 남아 있다.
- Software SAS 기능은 항상 false이며 Ctrl+Alt+Delete를 제공하지 않는다.
  이 기능들은 미검증 기능이 아니라 1.0.3에서 제공하지 않는 기능이다.

서비스나 세션 에이전트의 신원·상태·capability 확인이 실패하면 PC Control만
fail closed로 비활성화하며 터미널 원격 기능으로 권한을 우회하지 않는다.

## 수용된 미검증 범위

- Windows 10 22H2와 Windows 11의 다른 빌드, Home/Enterprise, domain/MDM 정책 조합
- 관리자 권한 서비스 설치·업데이트·제거, 방화벽 규칙과 실제 잠금/UAC 경로
- Fast User Switching, 다중 사용자, 다중 모니터, HDR와 GPU 제조사별 인코더
- 물리 Android 기기, OEM WebView/H.264, TalkBack, 실제 VPN 네트워크
- Windows Authenticode 미서명으로 인한 SmartScreen/Unknown Publisher 경고

이번 검증에는 관리자 권한으로 설치한 물리 Windows 환경의 서비스 수명주기나
물리 Android 장치 검증이 포함되지 않는다. 이 범위를 검증했다고 릴리스 노트나
배포 보고서에 표현해서는 안 된다.

## 배포 운영 범위

이번 안정화 작업은 서명 인증서·키스토어의 발급 또는 사용, GitHub Release나
Play Store 게시, AAB 배포, 자동 업데이트 운영을 수행하지 않는다. Windows
산출물은 기존 결정대로 Authenticode 미서명이며, Android 릴리스 APK 게시에는
별도의 보호된 장기키 서명 절차가 필요하다. Windows와 Android 업데이트는
GitHub Release에서 수동으로 제공하는 계약을 유지한다.

## 증거 계약

`local-rc-report.json`은
`current-windows-host-and-api-29-35-emulators` 정책 식별자, 정확한 전체
40자리 build SHA, 위 미검증 범위와 알려진 기능 한계를 포함해야 한다. 이
보고서는 미검증 환경을 검증 완료로 표현하지 않는다.

로컬 RC 검증에는 같은 하드웨어·전원 정책에서 수집한 기준 보고서를 명시적으로
전달한다.

```powershell
./scripts/verify-release-candidate.ps1 `
  -PerformanceBaselinePath C:\secure-release-evidence\desktop-performance-baseline.json `
  -PerformanceBaselineBuildSha <40-character-baseline-commit-sha>
```

기준과 후보 보고서는 각각 SHA-256으로 `local-rc-report.json`에 결속되며,
후보의 원시 25개 표본도 보고서에 포함된다.
두 보고서는 schema v2의 동일한 순서로 정확히 5회 워밍업과 25회 측정을
수행해야 한다. 검증기는 외부에서 지정한 기준/후보 commit SHA를 실제 preload
빌드 SHA와 대조하고, 깨끗한 제품/하네스 Git 상태, 실행 산출물·하네스·fixture와
lockfile 해시, fixture 출력 바이트 수, 실제 Node/Electron/Playwright 버전을
검증한다.
원본 Windows `MachineGuid`는 저장하지 않고 도메인 분리 SHA-256 지문만
기록한다. 기준과 후보는 이 호스트 지문, 활성 전원 구성표 GUID, 현재 AC/DC
전원, 공식 Windows effective power mode, base-plan 전체 설정 해시, 활성 overlay
설정 해시가 모두 같아야 한다. 각 환경 스냅샷 중 상태가 바뀌거나 수집 시작/종료
상태가 다르거나 Windows가 AC/DC 상태를 판별하지 못해도 실패한다.
빌드 Node는 `.nvmrc`의 정확한 `24.14.0`으로 고정한다. Release workflow가
다시 만든 `.vite`의 모든 launch artifact는 성능 측정 때 기록한 바이트 수와
SHA-256이 정확히 같아야 하므로, 다른 도구 체인이나 비결정적 재빌드 결과는
게시 산출물로 승격되지 않는다.
과거 제품 기준선은 해당 commit의 깨끗한 worktree에서 정확한 SHA로 패키징한 뒤,
현재의 깨끗한 하네스가 `EZTERMINAL_PERFORMANCE_MAIN_ENTRY`로 그
`.vite/build/main.js`를 실행해 수집한다. 기준선 제품 소스에 새 benchmark 파일을
복사해서 dirty 상태를 숨기는 방식은 허용하지 않는다.

빠른 로컬 병목 진단은 다음과 같이 릴리스 증거와 분리한다.

```powershell
$env:EZTERMINAL_RUN_PERFORMANCE_DIAGNOSTIC = '1'
$env:EZTERMINAL_PERFORMANCE_DIAGNOSTIC_METRICS = 'rows100kCompletionMs'
$env:EZTERMINAL_PERFORMANCE_DIAGNOSTIC_WARMUP_RUNS = '1'
$env:EZTERMINAL_PERFORMANCE_DIAGNOSTIC_MEASUREMENT_RUNS = '3'
pnpm exec playwright test e2e/release-performance.spec.ts
```

진단 모드는 선택한 지표에 대해 워밍업 0~5회, 측정 1~25회만 허용하고
`evidenceMode=diagnostic`을 기록한다. 검증기, 로컬 RC, Release workflow는
진단 보고서를 항상 거부한다. `EZTERMINAL_RUN_RELEASE_PERFORMANCE=1`이면 진단
환경변수와 무관하게 전체 4개 지표, 5회 워밍업, 25회 측정으로 고정된다.
