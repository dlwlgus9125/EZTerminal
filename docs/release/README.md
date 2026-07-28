# EZTerminal 1.0.x 릴리스 가이드

EZTerminal은 Windows Electron 앱과 Android Capacitor 클라이언트를 동일한
소스 SHA에서 빌드한다. Android APK는 기존 장기키로 서명하고, Windows
설치 파일은 현재 정책상 Authenticode `NotSigned`로 배포한다.

## 현재 계약

- 앱 버전: `1.0.13`
- Android versionCode: `34`
- 원격 프로토콜: v3
- Electron↔Rust native desktop protocol: v2
- 검증 프로필: `full`
- Windows: Windows 10 22H2/Windows 11 x64
- Android: Android 10(API 29) 이상
- 네트워크: 신뢰한 Tailscale/WireGuard VPN 내부의 실제 `ws://`

관련 문서:

- [1.0.13 릴리스 노트](release-notes-1.0.13.md)
- [1.0.13 검증 정책](validation-policy-1.0.13.md)
- [서명 준비와 인증서 지문 확인](signing.md)
- [PC Control 설계](../design/remote-desktop-design.md)

## 키와 보호된 환경

Android 장기키는 저장소에 커밋하지 않는다. GitHub Environment
`release`에는 다음 서명 secret을 등록한다.

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`
- `ANDROID_SIGNING_CERT_SHA256`

실제 APK 인증서, 위 secret, 그리고
`mobile/android/signing-certificate.sha256`은 모두 같은 SHA-256 지문이어야
한다. 로컬에서는 무시된 `.release-secrets/`의 기존 JKS와 현재 Windows
사용자에게 묶인 DPAPI credential만 사용한다. 로컬 wrapper는 비밀번호를
출력하거나 파일로 복호화하지 않으며 child Gradle process가 끝나면 환경변수를
지운다. 기존 credential을 사용할 수 없으면 새 키를 만들지 않고 실패한다.

같은 보호 Environment에는 최종 릴리스 승인 증거를 다음 이름으로 등록한다.

- variable `EZTERMINAL_LOCAL_RC_APPROVED_SHA`: 승인한 정확한 40자리 Git SHA
- variable `EZTERMINAL_LOCAL_RC_REPORT_SHA256`: `local-rc-report.json`의
  SHA-256
- variable `EZTERMINAL_LOCAL_RC_EVIDENCE_SHA256`: 승인 증거 ZIP의 SHA-256
- secret `EZTERMINAL_LOCAL_RC_EVIDENCE_BASE64`: 같은 ZIP 원문의 base64

승인 증거 ZIP은 중첩 디렉터리나 추가 파일 없이 다음 네 파일만 포함해야 한다.

- `local-rc-report.json`
- `mobile-soak-report.json`
- `desktop-performance-baseline.json`
- `desktop-performance-report.json`

Release workflow는 ZIP 해시를 먼저 확인하고 `RUNNER_TEMP`의 새 디렉터리에
안전하게 추출한다. 공유 검증기는 보호된 보고서가 참조하는 원본 해시, 모든
수치의 유한성, 기능 soak 결과와 원본 성능 기준선·후보 비교를 다시 계산한다.
보고서 하나만 신뢰하거나, 오래된 원본 증거를 다른 SHA에 재사용하지 않는다.

## 로컬 1.0.13 후보

변경을 깨끗한 로컬 커밋으로 동결한 뒤 다음 명령을 실행한다.

```powershell
./scripts/build-local-release-candidate.ps1 `
  -Api29Avd EZTerminalApi29 `
  -Api35Avd EZTerminalApi35
```

이 경로는 타입·린트·단위 테스트, 일반 `pnpm e2e`, Storybook/axe/시각 검증,
Rust 품질 게이트, 패키지 smoke, API 29/35 기기 검증, API 35 기능 soak,
서명 APK, SBOM과 체크섬을 실행한다. 결과는
`release-assets/1.0.13-rc-<sha8>/`에 격리한다.

후보 보고서는 다음 상태를 명시한다.

```json
{
  "releaseStage": "candidate",
  "desktopPerformance": {
    "status": "pending-final-release-measurement",
    "reason": "not-requested-for-this-local-rc"
  }
}
```

따라서 로컬 후보는 `publicationEligible=false`이며 과거 성능 보고서를 읽거나
복사하지 않는다. 같은 버전의 다른 SHA 후보를 만들더라도 이전 후보 디렉터리는
삭제하지 않는다. 산출물 스테이저의 기본 단계도 `candidate`이며, 이 상태에서는
성능 증거가 pending이어야 하고 게시용 릴리스 디렉터리를 만들 수 없다.

## 최종 릴리스 성능 게이트

성능 측정은 사용자가 “성능 측정해줘”처럼 명시적으로 요청한 경우에만 다음
옵트인으로 실행한다.

```powershell
./scripts/verify-release-candidate.ps1 `
  -Api29Avd EZTerminalApi29 `
  -Api35Avd EZTerminalApi35 `
  -PerformanceBaselinePath C:\secure-release-evidence\desktop-performance-baseline.json `
  -PerformanceBaselineBuildSha <40-character-baseline-commit-sha> `
  -RunPerformanceMeasurement
```

일반 build, test, update, package, RC 또는 release 요청은
`pnpm e2e:performance`, `e2e/release-performance.spec.ts`,
`EZTERMINAL_RUN_RELEASE_PERFORMANCE=1`,
`EZTERMINAL_RUN_PERFORMANCE_DIAGNOSTIC=1`,
`-RunPerformanceMeasurement`를 허가하지 않는다. 비성능 RC wrapper는 두
성능 실행 환경 변수를 상속한 경우 실행 전에 실패한다.

최종 Release workflow는 명시적으로 승인된 성능 측정으로 만든 exact-SHA
보고서의 성능 상태가 `passed`이고 전체 증거가 complete인지, API 29/35와
기능 soak 증거가 완전한지 다시 확인한다. pending 후보 보고서는 Android 키를
사용하거나 GitHub Release를 만들기 전에 거부한다. `release` 단계 스테이징은
깨끗한 작업 트리와 시작 시 동결한 정확한 HEAD SHA를 요구하며, 검증 도중
HEAD나 파일 상태가 바뀌면 실패한다.
최종 산출물은 `release-assets/1.0.13-release-<sha8>/`에만 스테이징하며,
후보와 최종 경로 모두 정확히 일치하는 해당 디렉터리만 재생성한다.

보호된 증거는 서명 전 검증 단계에서만 `RUNNER_TEMP`에 존재하고 검증·스테이징
직후 삭제한다. Android keystore도 서명에 필요한 단계에서만 복원하고 APK
조립 직후 삭제하며, 종료 정리 단계가 실패 경로의 잔여 파일도 제거한다.
검증·빌드 job은 `contents: read`만 사용하고 checkout credential을 Git 설정에
남기지 않는다. 태그 push에서만 별도 publish job이 `contents: write`를 얻어
빌드 job의 불변 artifact를 다시 다운로드한다. 이 job은 빌드 스크립트나
보호 secret을 실행하지 않고, 전달받은 `SHA256SUMS.txt` 해시, 각 파일 해시,
manifest의 exact SHA와 publication eligibility를 재검증한 뒤 draft만 만든다.

## 필수 검증 순서

1. 앱과 Android/Rust 버전 계약을 하나의 로컬 커밋으로 동결한다.
2. 비성능 로컬 후보 wrapper를 실행한다.
3. 다음 산출물을 검토한다.

   | 파일 | 계약 |
   |---|---|
   | `EZTerminal-Setup.exe` | ProductVersion 1.0.13, Authenticode `NotSigned` |
   | `EZTerminal-Android-1.0.13-vc34.apk` | API 29+, 장기키 서명, exact build SHA |
   | `local-rc-report.json` | schema v2, API별 lane, 기능 soak, 성능 pending/passed |
   | `mobile-soak-report.json` | 공유 검증기가 다시 검사한 원본 기능 soak 증거 |
   | `desktop-performance-baseline.json` | 최종 릴리스에만 포함되는 원본 성능 기준선 |
   | `desktop-performance-report.json` | 최종 릴리스에만 포함되는 원본 성능 후보 |
   | `sbom.cdx.json` | npm·Cargo CycloneDX SBOM |
   | `release-manifest.json` | 버전·프로토콜·SHA·원본 증거 해시·서명·publication eligibility |
   | `SHA256SUMS.txt` | 해당 후보 디렉터리의 전체 파일 해시 |

4. 성능 측정이 별도로 승인되면 같은 SHA에서 최종 증거를 수집한다.
5. 최종 보고서와 네 파일 ZIP, 승인 SHA 및 보고서·ZIP 해시를 보호된
   Environment에 등록한 뒤 `workflow_dispatch`로 통합 산출물을 검토한다.
6. SHA를 바꾸지 않고 `v1.0.13` 태그를 push하면 draft GitHub Release를 만든다.
   태그 push, merge, draft 게시 자체는 별도 운영 승인 대상이다.

## 설치와 잔여 제한

- Windows SmartScreen은 무서명 설치 파일에 알 수 없는 게시자 경고를 표시할
  수 있다. 설정과 레이아웃은 업그레이드 중 보존해야 한다.
- Android는 기존 장기키로만 업데이트할 수 있다. debug 또는 다른 인증서로
  설치된 과거 앱은 삭제 후 다시 페어링해야 한다.
- 잠금/UAC secure desktop과 Ctrl+Alt+Delete는 지원하지 않는다.
- Windows 10/Home/Enterprise/domain·MDM, 물리 Android/OEM camera·codec,
  TalkBack, hardware keyboard, 다중 모니터/HDR, 실제 지연 네트워크는 로컬
  emulator 후보의 완전한 자동 차단 증거가 아니다.
