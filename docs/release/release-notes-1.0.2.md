# EZTerminal 1.0.2

Codex를 EZTerminal 안에서 Windows Terminal처럼 안전하게 사용할 수 있도록 키보드와 클립보드 동작을 정리한 패치 릴리즈입니다.

## 주요 변경

- 직접 실행한 Codex에서 선택 영역이 없을 때 `Ctrl+C`와 `Ctrl+D`가 세션을 종료하지 않도록 보호합니다.
- `Esc`는 현재 Codex 작업 중단에 그대로 사용하며, `/exit`, `/quit`, 명시적인 **강제 종료**는 유지합니다.
- 선택 영역이 있으면 `Ctrl+C`가 일반 복사로 동작합니다.
- 이미지가 포함된 클립보드의 `Ctrl+V`는 Codex에 전달해 이미지 첨부를 처리합니다. EZTerminal은 임시 이미지 파일이나 경로를 만들지 않습니다.
- `Ctrl+Shift+V`와 `Shift+Insert`는 텍스트 붙여넣기를 강제하고, `Ctrl+Insert`는 선택 영역을 복사합니다.
- 여러 줄 또는 5 KiB 초과 텍스트 붙여넣기 경고를 추가했으며 두 경고를 설정에서 각각 끌 수 있습니다.
- 앱 단축키 충돌을 정리해 `Ctrl+P`와 `Ctrl+F`를 터미널 프로그램에 전달하고, 명령 모드와 xterm 검색은 각각 `Ctrl+Shift+P`, `Ctrl+Shift+F`로 사용합니다.
- 일반 PTY와 모바일의 기존 제어키 동작은 변경하지 않았습니다.

## 다운로드

- Windows 10 22H2 / Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10(API 29) 이상: `EZTerminal-Android-1.0.2-vc23.apk`
- 무결성 검증: `SHA256SUMS.txt`

Windows 빌드는 코드 서명되지 않아 SmartScreen 경고가 표시될 수 있습니다. Android APK는 1.0.0 이후와 같은 장기 릴리스 키로 서명되어 기존 설치 위에 업데이트할 수 있습니다.
