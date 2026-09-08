# EZTerminal 1.0.53

Release identity: remote protocol v12, Android versionCode 74.

프로젝트 탭에서 등록된 프로젝트가 삭제되지 않던 문제를 수정했습니다.

- 앱을 다시 실행한 뒤에도 이전 터미널 기록이 실행 중으로 남아 프로젝트 삭제를
  막던 문제를 해결했습니다. 시작 시 종료된 터미널의 상태를 복구합니다.
- 실제 실행 중인 세션이 있는 프로젝트의 삭제 보호는 유지됩니다.

업데이트 후 앱을 다시 실행하고 프로젝트 메뉴에서 삭제할 수 있습니다.
프로젝트 삭제는 등록 항목을 제거하며 프로젝트 폴더의 파일은 보존합니다.

## Downloads

- Windows 10 22H2 / Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 / API 29 이상: `EZTerminal-Android-1.0.53-vc74.apk`

Android는 기존 장기 릴리즈 인증서로 서명합니다. Windows 설치 파일은 현재
서명 정책에 따라 Authenticode `NotSigned`입니다.

공개 파일의 출처와 SHA-256 해시는 `release-manifest.json`, `SHA256SUMS.txt`에
기록합니다. 이번 릴리즈는 기존 `functional-hotfix` 검증 프로필을 사용하며,
이 릴리즈 SHA의 성능 측정이나 30분 soak 인증을 주장하지 않습니다.

See the [1.0.53 validation policy](validation-policy-1.0.53.md).
