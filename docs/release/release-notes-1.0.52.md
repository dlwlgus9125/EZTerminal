# EZTerminal 1.0.52

Release identity: remote protocol v12, Android versionCode 73.

기존 화면과 기능을 유지하면서 데스크톱과 Android의 내부 구조를 정리한 릴리즈입니다.

- 데스크톱 기능별 IPC 처리와 등록 해제를 같은 모듈에 모으고 서비스 의존성을
  명시했습니다.
- 원격 요청 검증과 OpenClaw 연결 상태, 모바일 Agent History·OpenClaw 요청의
  응답·시간초과·연결 종료 처리를 기능별로 정리했습니다.
- 데스크톱의 환경설정, 외형, Command Center, 프로젝트 탐색과 복구 상태를
  분리했습니다. 기존 세션·실행 소유권, 패널 수명과 PTY 출력 경로를 유지합니다.
- Android 검증을 현재 시작 화면에 맞추고, 힙 측정의 캐시·평가 객체 보관·강제 GC
  영향을 제거하도록 측정 도구를 보완했습니다.

공개 API와 저장 형식, 원격 프로토콜은 바뀌지 않았습니다.

## Downloads

- Windows 10 22H2 / Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 / API 29 이상: `EZTerminal-Android-1.0.52-vc73.apk`

Android는 기존 장기 릴리즈 인증서로 서명합니다. Windows 설치 파일은 현재
서명 정책에 따라 Authenticode `NotSigned`입니다.

공개 파일의 출처와 SHA-256 해시는 `release-manifest.json`, `SHA256SUMS.txt`에
기록합니다. 이번 릴리즈는 기존 `functional-hotfix` 검증 프로필을 사용하며,
새 릴리즈 SHA의 성능 측정이나 30분 soak 인증을 주장하지 않습니다.

See the [1.0.52 validation policy](validation-policy-1.0.52.md).
