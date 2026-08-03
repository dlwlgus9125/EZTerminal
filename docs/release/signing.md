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

### 로컬 1.0.13 후보

이 저장소의 로컬 검증 PC는 무시된 `.release-secrets/` 아래에 기존 장기
keystore와 현재 Windows 사용자에게 묶인 DPAPI 비밀번호를 보관한다.

- `android-release.jks`
- `android-release-password.dpapi.key`

`scripts/build-local-release-candidate.ps1`만 이 credential을 사용한다.
복호화한 비밀번호는 출력·파일 저장하지 않고 Gradle child process 환경에만
잠시 주입한 뒤 제거한다. 기본 별칭은 `ezterminal-release`다. DPAPI 복호화,
별칭, 서명 또는 커밋된 인증서 지문 검증이 실패하면 새 키나 임시 비밀번호를
생성하지 말고 기존 키 관리 절차로 복구한다.

### GitHub workflow 비밀 수명

보호된 Environment의 최종 승인 증거는 단일
`EZTERMINAL_LOCAL_RC_EVIDENCE_BASE64` secret으로 전달한다. 이 값은 증거
검증 단계에만 주입하고, SHA-256을 확인한 ZIP을 `RUNNER_TEMP`의 새 디렉터리에
안전하게 추출한다. 추출된 증거와 ZIP은 릴리스 스테이징 직후 삭제하며 종료
정리 단계가 실패 경로의 잔여 파일도 제거한다.

Android 서명 secret도 작업 전체에 노출하지 않는다.
`ANDROID_KEYSTORE_BASE64`와 인증서 지문은 keystore 복원·확인 단계에만,
keystore/키 비밀번호와 별칭은 APK를 조립하는 Gradle 단계에만 주입한다.
keystore 파일은 APK 조립 직후 삭제한다. 후속 단계는 비밀번호나 base64
원문 대신 검증된 APK와 인증서 지문만 사용한다.

검증과 빌드는 read-only repository token 및 `persist-credentials: false`로
수행한다. `contents: write`는 별도 publish job에만 부여한다. publish job은
보호 secret이나 저장소 빌드 명령을 사용하지 않으며, 다운로드한 artifact의
빌드-job `SHA256SUMS.txt` 해시와 manifest/file 해시를 재검증한 뒤에만 draft
GitHub Release를 생성한다.

## Windows SignPath Foundation 서명

SignPath 심사 중에는 `release/version.json`의 `windowsSigningMode`를
`unsigned`로 명시한 유지보수 릴리스를 허용한다. 이 모드에서는 SignPath
설정값 여섯 개가 모두 없어야 하며, 앱, Rust remote host, NSIS 제거 프로그램,
Setup이 모두 `NotSigned`인지 확인한다. manifest와 `SHA256SUMS.txt` 무결성
검증은 유지되지만 Windows의 알 수 없는 게시자 경고는 없앨 수 없다.

승인 후에는 같은 값을 `signpath`로 바꾼 커밋부터 SignPath Foundation의
오픈소스 인증서를 사용하며 Windows에 표시되는 게시자는 정확히
`SignPath Foundation`이다. Release workflow는 앱, Rust remote host, NSIS
제거 프로그램을 먼저 서명하고 그 결과로 설치 프로그램을 다시 만든 뒤
Setup을 두 번째로 서명한다. SignPath 정책상 두 요청은 릴리스마다 각각
수동 승인을 받아야 한다.

워크플로는 네 파일 모두에서 유효한 Authenticode, 게시자, RFC 3161
타임스탬프, 제품명·버전, 파일·인증서 해시를 검사한다. 이 증거와 두 SignPath
request ID가 완전하지 않으면 `release-manifest.json`을 만들거나 게시할 수
없다. 설치 후에도 내부 앱, remote host, 제거 프로그램을 다시 검사한다.

로컬 `pnpm make`와 로컬 RC는 계속 무서명이다. PFX 환경 변수는 두 경로에서
모두 거부된다. `unsigned` 모드에 SignPath 값이 하나라도 있거나 `signpath`
모드에서 하나라도 빠지면 패키징 전에 실패한다. 따라서 SignPath 요청 실패를
무서명 게시로 자동 우회할 수 없다. 초기에는 유효한 서명과 별개로 SmartScreen
평판 경고가 남을 수 있다. 자세한 신청·설정 절차는
[SignPath Windows release setup](signpath-setup.md), 공개 역할과 책임은
[Code signing policy](../../CODE_SIGNING_POLICY.md)를 따른다.
