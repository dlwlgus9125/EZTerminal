# EZTerminal 1.0.0

EZTerminal의 첫 안정 릴리스입니다. Windows Adaptive Workbench와 Android 원격 앱에서 터미널, 세션, 파일, 에이전트, 모니터, 테마 및 핵심 설정의 결과 동등성을 제공합니다.

## 설치 전 확인

- Windows 설치 파일은 코드서명되지 않았으므로 SmartScreen에서 “알 수 없는 게시자” 경고가 표시될 수 있습니다.
- Android 1.0은 새 장기 릴리스 인증서를 사용합니다. 이전 디버그 서명 APK가 설치되어 있다면 먼저 삭제해야 하며 저장된 페어링 정보도 삭제됩니다.
- Android 앱은 PC와 함께 업데이트하십시오. 호환되지 않는 프로토콜 버전은 연결되지 않습니다.
- 모바일 원격 연결은 평문 `ws://`입니다. 신뢰할 수 있는 LAN 또는 Tailscale/WireGuard에서만 사용하십시오. 페어링된 기기는 PC 사용자의 명령 실행 및 파일 접근 권한을 가집니다.

## 다운로드 검증

`SHA256SUMS.txt`로 다운로드한 설치 파일 또는 APK를 확인하십시오. `release-manifest.json`에는 전체 소스 SHA, 앱/프로토콜 버전과 서명 상태가 기록됩니다.

지원 환경은 Windows 10 22H2/Windows 11 x64와 Android 10(API 29) 이상입니다. 업데이트는 양쪽 플랫폼 모두 GitHub Release를 통한 수동 설치입니다.

Android 10의 초기 WebView 74에서도 xterm 터미널, 파일 업로드, 테마 가져오기와 모달 포커스 격리가 동작하도록 호환 계층을 포함합니다. 다만 보안 패치를 위해 Android System WebView는 가능한 최신 버전으로 업데이트하는 것을 권장합니다.

모바일에서 PC 파일을 내려받으면 Android의 범위 지정 저장소를 통해 `Downloads/EZTerminal`에 저장됩니다. 최대 50 MiB 파일도 256 KiB 단위로 네이티브 저장하며, 중단된 전송의 부분 파일은 자동 정리됩니다. 광범위한 저장소 권한은 요청하지 않습니다.
