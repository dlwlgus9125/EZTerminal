# EZTerminal 1.0.x 릴리스 가이드

EZTerminal 1.0.x는 Windows Electron 앱과 Android Capacitor 원격 클라이언트를 동일한 소스 SHA에서 빌드해 draft GitHub Release로 배포한다. Android APK는 보호된 장기키로 서명하고 검증 후 GitHub Release를 게시한다. 자동 업데이트와 Play Store/AAB 배포, 장기키 발급·교체는 이 절차에 포함하지 않는다.

## 관련 문서

- [1.0.4 릴리스 노트](release-notes-1.0.4.md)
- [1.0.4 검증 정책과 잔여 위험](validation-policy-1.0.4.md)
- [서명 준비와 인증서 지문 확인](signing.md)
- [PC Control 설계와 현재 구현 상태](../design/remote-desktop-design.md)

## 지원 및 배포 계약

- Windows: Windows 10 22H2 또는 Windows 11, x64, 무서명 NSIS 관리자 설치 파일
- Android: Android 10(API 29) 이상, GitHub Release의 장기키 서명 APK
- 네트워크: Tailscale/WireGuard 또는 명시적으로 신뢰한 VPN 인터페이스의 `ws://` 연결만 지원
- PC Control: 잠금되지 않은 데스크톱만 지원한다. 준비된 host service가 있을 때만 capability를 광고하며, 제어 시작에는 활성 세션 agent handshake가 추가로 필요하다. 잠금/UAC secure desktop과 Ctrl+Alt+Delete는 1.0.4에서 지원하지 않는다.
- 버전: 데스크톱·모바일·Android `versionName`은 `1.0.4`, 현재 패치 후보의 `versionCode`는 25
- 같은 SHA의 빌드 재시도는 versionCode를 올리지 않는다. 외부에 전달한 후보를 교체할 때는 26 이상으로 증가시킨다.

## 최초 1.0 준비

1. 저장소 밖에서 장기 Android 키를 생성한다. 권장값은 RSA 4096, 별칭 `ezterminal-release`, 유효기간 25년 이상이다.
2. 키스토어와 비밀번호를 암호 관리자와 오프라인 백업에 각각 보관한다. 키스토어·인증서·비밀번호는 커밋하지 않는다.
3. GitHub에 필수 검토자가 있는 보호된 Environment `release`를 만들고 다음 Environment secrets를 등록한다.
   - `ANDROID_KEYSTORE_BASE64`
   - `ANDROID_KEYSTORE_PASSWORD`
   - `ANDROID_KEY_ALIAS`
   - `ANDROID_KEY_PASSWORD`
   - `ANDROID_SIGNING_CERT_SHA256`
4. 마지막 값은 키 인증서의 SHA-256 지문 64자리다. 같은 공개 지문을 `mobile/android/signing-certificate.sha256`의 `UNCONFIGURED` 대신 커밋한다. `.github/workflows/release.yml`은 커밋된 지문, 보호된 secret, 실제 APK 인증서 세 값이 모두 같아야 통과한다. 새 장기키가 생성되기 전의 `UNCONFIGURED`는 의도적인 릴리스 차단 상태다.
5. 로컬 RC가 끝난 뒤 스크립트가 출력하는 명령으로 다음 Environment variables를 설정한다.
   - `EZTERMINAL_LOCAL_RC_APPROVED_SHA`: 승인한 전체 40자리 Git SHA
   - `EZTERMINAL_LOCAL_RC_REPORT_SHA256`: `local-rc-report.json`의 SHA-256
   - Environment secret `EZTERMINAL_LOCAL_RC_REPORT_BASE64`: 같은 보고서 원문을 base64로 인코딩한 값

Release workflow는 API 29/35 계측 테스트를 다시 실행한다. 또한 보호된 보고서
원문의 SHA-256, build SHA, API 29/35 AVD, 같은 Windows PC의 성능 기준/후보
비교, API 35의 30분 8세션·20회 복구 소크 결과를 직접 검증하고 하나라도
다르면 Android 키를 사용하기 전에 실패한다. 현재 후보의 제한된 검증 범위와
수용 위험은 [validation-policy-1.0.4.md](validation-policy-1.0.4.md)에 고정한다.

자세한 키 생성·지문 확인 방법은 [signing.md](signing.md)를 따른다.

## 검증 순서

1. 모든 1.0 변경을 하나의 깨끗한 커밋으로 동결한다.
2. Windows 개발 PC에서 API 29/API 35 AVD를 준비한다. 같은 PC와 전원 정책에서
   이전 후보의 성능 기준 보고서를 수집한 뒤 로컬 RC 게이트를 실행한다.

   ```powershell
   ./scripts/verify-release-candidate.ps1 `
     -Api29Avd EZTerminalApi29 `
     -Api35Avd EZTerminalApi35 `
     -PerformanceBaselinePath C:\secure-release-evidence\desktop-performance-baseline.json `
     -PerformanceBaselineBuildSha <40-character-baseline-commit-sha>
   ```

   데스크톱 성능은 5회 워밍업 뒤 25회 측정하고, 모든 p95 회귀를 5% 이내로
   제한한다. 12 MiB plain-output 보존 압력 병목은 15% 이상 개선되어야 한다.
   기준선과 후보 보고서는 schema v2를 사용하며, 실제 preload 빌드 SHA, 깨끗한
   제품/하네스 Git 상태, 실행 산출물·하네스·fixture·lockfile SHA-256, fixture
   출력 바이트 수, 실제 Node/Electron/Playwright 버전을 포함해야 한다.
   원본 기기 식별자는 보고서에 저장하지 않는다. 대신 해시한 Windows 호스트
   지문과 활성 전원 구성표 GUID, 현재 AC/DC 전원, 공식 Windows effective power
   mode, base-plan 전체 설정 해시, 활성 overlay 설정 해시를 기록하고 기준/후보에서
   정확히 비교한다. 각 환경 스냅샷 중 상태가 바뀌거나 수집 시작/종료 상태가
   다르거나 Windows가 상태를 판별하지 못하면 증거 생성을 거부한다. 로컬 RC와
   Release workflow는 모두 `.nvmrc`의 정확한
   Node 버전을 사용하며, workflow가 재빌드한 모든 `.vite` launch artifact의
   바이트 수와 SHA-256을 측정 보고서와 다시 대조한 뒤에만 설치 파일을 staging한다.
   과거 제품 기준선을 다시 수집할 때는 과거 commit의 깨끗한 worktree에서
   `EZTERMINAL_BUILD_SHA`를 지정해 먼저 패키징하고, 현재의 깨끗한 하네스에서만
   `EZTERMINAL_PERFORMANCE_MAIN_ENTRY=<baseline-worktree>\.vite\build\main.js`를
   지정한다. 이 전용 override는 제품 소스와 측정 하네스를 섞지 않고 동일한
   하네스/fixture로 두 제품을 비교하기 위한 것이다.
   개발 중 빠른 병목 확인은 `EZTERMINAL_RUN_PERFORMANCE_DIAGNOSTIC=1`과
   `EZTERMINAL_PERFORMANCE_DIAGNOSTIC_METRICS`, `..._WARMUP_RUNS`,
   `..._MEASUREMENT_RUNS`를 사용한다. 이 보고서는 `evidenceMode=diagnostic`이며
   비교 검증기, 로컬 RC, Release workflow에서 항상 거부된다. 릴리스 모드는
   진단 설정과 무관하게 전체 4개 지표와 5/25 프로토콜을 사용한다.
   API 35 AVD에서 30분 동안 8세션, 정확히 20회 백그라운드·브리지 복구,
   재연결/재개 중복과 메모리 성장 한도를 검증한다. 원시 성능 표본, 기준/후보
   해시와 소크 요약은 `release-assets/local-rc-report.json`에 기록된다.
3. `workflow_dispatch`로 Release workflow를 실행해 동일 SHA의 통합 RC 산출물을 검토한다. Playwright 릴리스 테스트는 재시도 없이 실행되고, 각 모바일 연결 시나리오는 첫 연결 결과 한 번만 허용한다.
4. SHA를 변경하지 않은 상태에서 `v1.0.4` 태그를 push한다. workflow가 새로 검증하고 draft Release를 만든다.
5. `release-manifest.json`, `SHA256SUMS.txt`, 버전, Android 인증서 지문과 로컬 RC 결과를 대조한 뒤 사람이 draft를 게시한다.

## 산출물

| 파일 | 계약 |
|---|---|
| `EZTerminal-Setup.exe` | ProductVersion 1.0.4, Authenticode `NotSigned` |
| `local-rc-report.json` | exact SHA, API 29/35, 데스크톱 성능 비교와 30분 소크의 검증된 증거 |
| `sbom.cdx.json` | npm·Cargo 프로덕션 의존성의 CycloneDX 1.5 SBOM |
| `EZTerminal-Android-1.0.4-vc25.apk` | applicationId `com.ezterminal.remote`, API 29+, 장기키 연속 서명 |
| `release-manifest.json` | 앱/프로토콜 버전, versionCode, 전체 build SHA, RC 보고서 해시, 서명 상태 |
| `SHA256SUMS.txt` | 모든 게시 산출물의 SHA-256 |

프로덕션 모바일 `dist`와 최종 APK에 `[ez-e2e]` 문자열이 남으면 릴리스는 실패한다. E2E APK는 로컬 검증에만 사용하고 GitHub Release에 첨부하지 않는다.

## 설치·업데이트 확인

### Windows

1. 현재 Windows 11 Pro 검증 PC에서 신규 설치, 자동 실행, 시작 메뉴 바로가기와 기본 명령/PTY를 확인한다.
2. 0.9 설치본에서 1.0으로 업그레이드하고 설정·레이아웃 보존을 확인한다.
3. 기존 Squirrel 설치에서 NSIS로 교체되고 설정이 보존되는지 확인한다. 제거 후 서비스·방화벽·설치 관리 정책은 제거되며 `%APPDATA%\EZTerminal` 사용자 데이터는 보존되어야 한다.
4. Windows 1.0은 무서명이므로 SmartScreen의 알 수 없는 게시자 경고를 릴리스 노트와 다운로드 안내에 유지한다.

### Android

1. 1.0 이전 APK는 디버그 인증서로 서명됐다. 기존 앱을 삭제한 뒤 1.0 APK를 새로 설치하고 다시 페어링한다. 삭제 시 앱의 로컬 페어링 정보가 사라진다.
2. API 29와 API 35 AVD에서 페어링, 터미널, 세션 재개, 파일 전송, 에이전트,
   모니터, 테마와 설정을 확인한다.
3. 1.0 이후에는 같은 장기키를 영구 사용한다. 키를 분실하면 기존 설치에 업데이트할 수 없다.

Windows와 Android 모두 업데이트는 GitHub Release에서 수동으로 받는다. 두 앱의 프로토콜 버전이 다르면 재연결하지 않고 양쪽 업데이트 안내를 표시해야 한다.

Windows 10/Home/Enterprise/domain·MDM, 관리자 서비스 설치·방화벽, 물리
Android/OEM 코덱/TalkBack 및 다중 모니터·HDR 경로는 이번 RC의 자동 차단
증거가 아니다. 지원 문구는 유지하되 이 미검증 범위를
`local-rc-report.json`의 `acceptedResidualRisks`에 반드시 남긴다. 잠금/UAC
secure desktop과 Software SAS는 단순 미검증 범위가 아니라 1.0.4의 알려진
미지원 기능으로 별도 표시한다.
