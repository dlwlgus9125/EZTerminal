# EZTerminal 1.0.51

Release identity: remote protocol v12, Android versionCode 72.

- PC와 Android 새 세션을 Terminal과 Agent 두 항목으로 정리했습니다.
  Terminal에서 일반 셸 또는 설치된 CLI를 선택하고, 지원하는 CLI의 모델을
  지정할 수 있습니다. 일반 터미널이 기본입니다.
- Agent의 별도 '앱에서 대화' 선택을 없앴습니다. 만들기를 누르면 빈 대화창이
  열리며 첫 메시지를 전송할 때 실제 Agent 작업을 시작합니다.
- PC 대화는 Enter로 전송하고 Shift+Enter로 줄을 바꿉니다. 한글 조합 중에는
  전송하지 않습니다. Android는 줄바꿈 입력과 전송 버튼을 유지합니다.
- Agent 생성 화면의 모델·권한 설정을 접어 두었습니다. 아직 시작하지 않은
  대화도 복원하고 설정을 변경할 수 있습니다.

## Installers

- Windows x64: `EZTerminal-Setup.exe`
- Android 10 / API 29 이상: `EZTerminal-Android-1.0.51-vc72.apk`

Android는 기존 장기 릴리즈 인증서로 서명해 기존 릴리즈 설치 위에 업데이트할 수
있습니다. Windows 설치파일은 현재 서명 정책에 따라 Authenticode `NotSigned`입니다.
`SHA256SUMS.txt`와 `local-build-receipt.json`에 파일 해시와 빌드 소스를 기록합니다.

이번 산출물은 직접 설치·전달하기 위한 로컬 릴리즈 빌드입니다. 공개 게시나 전체
릴리즈 인증을 의미하지 않으며 성능 측정은 실행하지 않습니다.

See the [1.0.51 validation policy](validation-policy-1.0.51.md).
