# EZTerminal 1.0 릴리스 가이드

EZTerminal 1.0은 Windows Electron 앱과 Android Capacitor 원격 클라이언트를 동일한 소스 SHA에서 빌드해 draft GitHub Release로 배포한다. 자동 업데이트와 Play Store/AAB 배포는 사용하지 않는다.

## 지원 및 배포 계약

- Windows: Windows 10 22H2 또는 Windows 11, x64, 무서명 Squirrel 설치 파일
- Android: Android 10(API 29) 이상, GitHub Release의 장기키 서명 APK
- 네트워크: 신뢰할 수 있는 LAN 또는 Tailscale/WireGuard의 `ws://` 연결만 지원
- 버전: 데스크톱·모바일·Android `versionName`은 `1.0.0`, 최초 공개 후보의 `versionCode`는 21
- 같은 SHA의 빌드 재시도는 versionCode를 올리지 않는다. 외부에 전달한 후보를 교체할 때만 22 이상으로 증가시킨다.

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

Release workflow는 API 29/35 계측 테스트를 다시 실행한다. 또한 보호된 보고서 원문의 SHA-256, build SHA, API 29/35 AVD, 물리 Fold/QEMU 판별, 수동 승인, 30분 8세션·20회 복구 소크 결과를 직접 검증하고 하나라도 다르면 Android 키를 사용하기 전에 실패한다.

자세한 키 생성·지문 확인 방법은 [signing.md](signing.md)를 따른다.

## 검증 순서

1. 모든 1.0 변경을 하나의 깨끗한 커밋으로 동결한다.
2. Windows 개발 PC에서 API 29/API 35 AVD와 물리 Fold 기기를 준비하고 로컬 RC 게이트를 실행한다.

   ```powershell
   ./scripts/verify-release-candidate.ps1 `
     -Api29Avd EZTerminalApi29 `
     -Api35Avd EZTerminalApi35 `
     -PhysicalDeviceSerial <adb-serial> `
     -PhysicalChecklistApproved
   ```

   `PhysicalChecklistApproved`는 접힘/펼침, 가로/세로, 컷아웃, 소프트 키보드, Android Back, TalkBack을 직접 확인한 뒤에만 지정한다. 스크립트는 `emulator-*`/QEMU 기기를 거부하고 실제 기기가 Android device-state API로 둘 이상의 자세 상태를 보고해야만 통과한다. 물리 기기 연결은 임시 `adb reverse` loopback으로 고정하고 종료 시 제거한다. 같은 기기에서 30분 동안 8세션, 정확히 20회 백그라운드·브리지 복구, 재연결/재개 중복과 메모리 성장 한도를 검증한다. 제조사·모델·자세 상태와 소크 요약은 `release-assets/local-rc-report.json`에 기록된다.
3. `workflow_dispatch`로 Release workflow를 실행해 동일 SHA의 통합 RC 산출물을 검토한다. Playwright 릴리스 테스트는 재시도 없이 실행되고, 각 모바일 연결 시나리오는 첫 연결 결과 한 번만 허용한다.
4. SHA를 변경하지 않은 상태에서 `v1.0.0` 태그를 push한다. workflow가 새로 검증하고 draft Release를 만든다.
5. `release-manifest.json`, `SHA256SUMS.txt`, 버전, Android 인증서 지문과 로컬 RC 결과를 대조한 뒤 사람이 draft를 게시한다.

## 산출물

| 파일 | 계약 |
|---|---|
| `EZTerminal-Setup.exe` | ProductVersion 1.0.0, Authenticode `NotSigned` |
| `ezterminal-1.0.0-full.nupkg` | Squirrel `RELEASES`의 SHA-1/길이와 일치 |
| `RELEASES` | 위 full package를 정확히 참조 |
| `local-rc-report.json` | exact SHA, API 29/35, 물리 Fold 승인과 30분 소크의 검증된 증거 |
| `EZTerminal-Android-1.0.0-vc21.apk` | applicationId `com.ezterminal.remote`, API 29+, 새 장기키 서명 |
| `release-manifest.json` | 앱/프로토콜 버전, versionCode, 전체 build SHA, RC 보고서 해시, 서명 상태 |
| `SHA256SUMS.txt` | 모든 게시 산출물의 SHA-256 |

프로덕션 모바일 `dist`와 최종 APK에 `[ez-e2e]` 문자열이 남으면 릴리스는 실패한다. E2E APK는 로컬 검증에만 사용하고 GitHub Release에 첨부하지 않는다.

## 설치·업데이트 확인

### Windows

1. Windows 10 22H2와 Windows 11에서 신규 설치, 자동 실행, 시작 메뉴 바로가기와 기본 명령/PTY를 확인한다.
2. 0.9 설치본에서 1.0으로 업그레이드하고 설정·레이아웃 보존을 확인한다.
3. 제거 후 Squirrel 바이너리는 삭제되고 `%APPDATA%\EZTerminal` 사용자 데이터가 정책대로 보존되는지 확인한다.
4. Windows 1.0은 무서명이므로 SmartScreen의 알 수 없는 게시자 경고를 릴리스 노트와 다운로드 안내에 유지한다.

### Android

1. 1.0 이전 APK는 디버그 인증서로 서명됐다. 기존 앱을 삭제한 뒤 1.0 APK를 새로 설치하고 다시 페어링한다. 삭제 시 앱의 로컬 페어링 정보가 사라진다.
2. API 29, API 35와 물리 Fold 기기에서 페어링, 터미널, 세션 재개, 파일 전송, 에이전트, 모니터, 테마와 설정을 확인한다.
3. 1.0 이후에는 같은 장기키를 영구 사용한다. 키를 분실하면 기존 설치에 업데이트할 수 없다.

Windows와 Android 모두 업데이트는 GitHub Release에서 수동으로 받는다. 두 앱의 프로토콜 버전이 다르면 재연결하지 않고 양쪽 업데이트 안내를 표시해야 한다.
