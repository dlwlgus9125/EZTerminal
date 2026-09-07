# EZTerminal 1.0.50

Release identity: remote protocol v12, Android versionCode 71.

- 새 세션은 PC와 Android에서 터미널로 바로 시작합니다. 명시적으로 Agent를
  시작하면 터미널 CLI가 기본이며, 앱 내 대화는 별도로 선택합니다.
- 설치된 CLI는 앱 내 대화 설정이나 SDK 버전 검사 없이 실행합니다.
- 설정은 CLI 상태를 먼저 보여 주고 선택 기능과 자세한 진단은 접어 둡니다.
- Agent의 대화와 도구 출력은 민감한 텍스트를 포함해 원문으로 표시·저장합니다.
  이전에 이미 가려져 저장된 텍스트의 원문은 복구할 수 없습니다.
- Android 재연결 시 이전 터미널 화면과 작업 위치를 복원합니다. 좁은 PC 화면에서
  새 작업을 가리던 사이드바와 설정 로딩 중 확대 버튼이 이동하던 문제를 수정했습니다.

## Installers

- Windows x64: `EZTerminal-Setup.exe`
- Android 10 / API 29 이상: `EZTerminal-Android-1.0.50-vc71.apk`

Android는 기존 장기 릴리즈 인증서로 서명해 기존 릴리즈 설치 위에 업데이트할 수
있습니다. Windows 설치파일은 현재 서명 정책에 따라 Authenticode `NotSigned`입니다.
`SHA256SUMS.txt`와 `local-build-receipt.json`에 파일 해시와 빌드 소스를 기록합니다.

이번 산출물은 직접 설치·전달하기 위한 로컬 릴리즈 빌드입니다. 공개 게시나 전체
릴리즈 인증을 의미하지 않으며 성능 측정은 실행하지 않습니다.

See the [1.0.50 validation policy](validation-policy-1.0.50.md).
