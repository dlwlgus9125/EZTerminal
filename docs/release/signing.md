# EZTerminal 1.0 서명 정책

## Android 장기 릴리스키

1. 저장소 밖의 안전한 작업 폴더에서 키를 한 번 생성한다.

   ```powershell
   keytool -genkeypair -v `
     -keystore ezterminal-release.jks `
     -alias ezterminal-release `
     -keyalg RSA -keysize 4096 -validity 10000
   ```

2. 인증서 지문을 확인하고 공백/콜론을 제외한 SHA-256 64자리를 기록한다.

   ```powershell
   keytool -list -v -keystore ezterminal-release.jks -alias ezterminal-release
   ```

3. 키스토어를 base64로 변환해 GitHub Environment `release`의 `ANDROID_KEYSTORE_BASE64` secret에 등록한다.

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes('ezterminal-release.jks')) |
     Set-Clipboard
   ```

4. 키스토어/키 비밀번호와 별칭, SHA-256 지문도 각각 Environment secret으로 등록한다.
5. 공개 SHA-256 지문을 `mobile/android/signing-certificate.sha256`의 `UNCONFIGURED` 대신 한 줄로 커밋한다. workflow는 커밋된 지문, 보호된 secret과 실제 APK 인증서가 모두 같지 않으면 실패한다.

키스토어는 GitHub만 유일하게 보관해서는 안 된다. 암호화된 오프라인 사본과 암호 관리자 사본을 별도 위치에 유지한다. 인증서 지문은 공개 정보이므로 저장소에 고정해 보호된 Environment가 유일한 신뢰 근거가 되지 않게 한다. 저장소 지문이 `UNCONFIGURED`인 경우 Release workflow는 의도적으로 차단된다.

1.0 이전 APK는 Android Debug 인증서로 서명됐다. 새 키와 서명 연속성이 없으므로 기존 앱을 한 번 삭제하고 다시 설치해야 한다. 이후 공개 APK는 반드시 같은 장기키를 사용한다.

## Windows 1.0

Windows 1.0 공개 산출물은 의도적으로 무서명이다. Release workflow는 `EZTerminal.exe`와 `EZTerminal-Setup.exe`의 Authenticode 상태가 정확히 `NotSigned`인지 확인하고 `release-manifest.json`에 기록한다. 사용자는 첫 실행 때 SmartScreen의 알 수 없는 게시자 경고를 볼 수 있다.

`forge.config.ts`의 선택적 PFX 지원은 향후 인증서 도입을 위해 남아 있지만 1.0 Release workflow는 PFX를 주입하지 않는다. 정식 Windows 인증서를 도입할 때는 검증 계약과 문서를 함께 변경하고 별도의 릴리스 후보에서 시험한다.
