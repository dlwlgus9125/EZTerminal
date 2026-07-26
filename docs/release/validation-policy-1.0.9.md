# EZTerminal 1.0.9 검증 정책과 잔여 위험

## 지원 기준

- Windows 10 22H2 또는 Windows 11 x64 데스크톱 앱과 원격 호스트 서비스
- Android 10(API 29) 이상 Capacitor 클라이언트
- Tailscale/WireGuard 또는 사용자가 명시적으로 선택한 VPN 인터페이스
- 잠금되지 않은 일반 사용자 데스크톱의 원격 화면·입력 제어

## 이번 핫픽스의 릴리스 게이트

- 동일한 깨끗한 Git SHA에서 버전 계약, 타입 검사, 린트, Rust·루트·모바일
  단위 테스트와 일반 데스크톱 E2E를 실행합니다.
- Android에서 시작한 실행의 포트 임대와 실행자 신원 수명주기를 독립적으로
  검증하고, 5분 임대 만료 뒤에도 같은 설치만 자동 복원할 수 있는지 확인합니다.
- 실제 Android 앱 강제종료 후 330초가 지난 뒤 원래 PTY의 출력 재생, 입력
  제어권 복원 및 입력 전달을 검증합니다.
- Windows 설치 파일과 Android 프로덕션 APK를 같은 SHA에서 빌드하고,
  Android APK는 기존 장기 키로 서명한 뒤 버전·인증서 지문을 확인합니다.
- API 29/API 35 Android 계측 검증과 패키지된 Windows 앱 검증을 수행합니다.
- 기능 핫픽스 결정에 따라 `pnpm e2e:performance`,
  `e2e/release-performance.spec.ts`, `-RunPerformanceMeasurement`를 실행하지
  않습니다. 과거 보고서를 새 SHA의 성능 증거로 재사용하지 않습니다.

## 알려진 기능 제한

- 잠금 화면과 UAC 보안 데스크톱 캡처·입력은 지원하지 않습니다.
- Software SAS와 Ctrl+Alt+Delete는 지원하지 않습니다.
- GDI 캡처, OpenH264 인코딩과 SendInput 주입은 일반 사용자 전송
  프로세스에서 실행됩니다.

## 수용된 잔여 위험

- 이번 SHA에 대한 데스크톱 성능 회귀 비교와 30분 모바일 소크를 수행하지
  않으므로 이 릴리스는 두 결과를 주장하지 않습니다.
- Windows 10/Home/Enterprise, 도메인 및 MDM 정책 경로는 자동 검증하지
  않습니다.
- 실제 복구 시나리오는 API 35 에뮬레이터에서 검증했으며, OEM별 Android
  프로세스 정책, 디코더, TalkBack, 하드웨어 키보드는 자동 검증하지 않습니다.
- 멀티 모니터, HDR 및 공급업체별 GPU 인코더 경로는 자동 검증하지 않습니다.
- 물리 네트워크의 10 Mbps/80 ms 제한 조건은 자동 검증하지 않습니다.
