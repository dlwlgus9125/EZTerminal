# EZTerminal 1.0.54

Release identity: remote protocol v12, Android versionCode 75.

터미널 작업 중 화면 전체가 검게 보이던 현상과 관련해 렌더링 안정성을 개선했습니다.

- CRT 깜빡임 효과를 앱 내용과 분리해, 탭·목록·터미널 전체의 투명도를 동시에 바꾸지 않습니다.
- 다른 창으로 포커스를 옮겨도 터미널 그래픽 렌더러를 유지합니다. 숨긴 상태가 일정 시간
  지속될 때 자원을 해제하고, 돌아오면 같은 터미널에서 출력을 이어갑니다.
- 창 상태에 따른 효과 중지·재개를 즉시 반영하고, 동일한 창 절전 설정의 반복 적용을 막았습니다.

기존 테마·효과 설정과 세션 동작은 유지됩니다. 이번 변경은 검은 화면과 연관될 수 있는
코드 경로를 줄이는 예방 수정이며, 모든 환경에서의 재발 방지를 보증하지 않습니다.

## Downloads

- Windows 10 22H2 / Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 / API 29 이상: `EZTerminal-Android-1.0.54-vc75.apk`

Android는 기존 장기 릴리즈 인증서로 서명합니다. Windows 설치 파일은 현재
서명 정책에 따라 Authenticode `NotSigned`입니다.

공개 파일의 출처와 SHA-256 해시는 `release-manifest.json`, `SHA256SUMS.txt`에
기록합니다. 이번 릴리즈는 기존 `functional-hotfix` 검증 프로필을 사용하며,
이 릴리즈 SHA의 성능 측정이나 30분 soak 인증을 주장하지 않습니다.

See the [1.0.54 validation policy](validation-policy-1.0.54.md).
