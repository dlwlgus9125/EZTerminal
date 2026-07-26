# EZTerminal 1.0.7

## 모바일 PC Control 복구

- Windows 원격 호스트 서비스가 정상 실행 중인데도 모바일의 **More → PC
  Control**이 “사용할 수 없음”으로 표시되던 문제를 수정했습니다.
- Electron 서비스 probe와 네이티브 원격 호스트가 같은 내부 프로토콜 v2 계약을
  사용하도록 통합했습니다.
- 잘못된 버전이나 손상된 probe 응답은 기존처럼 PC Control만 비활성화하고
  터미널 원격 기능은 유지합니다.

## 회귀 방지

- 실제 원격 호스트가 출력하는 v2 `ready` 응답과 나머지 서비스 상태를 단위
  테스트로 고정했습니다.
- Rust와 Electron의 내부 원격 호스트 프로토콜 버전이 다르면 버전 계약 검증이
  실패합니다.

## 검증 범위

- 타입 검사, 린트, Rust·루트·모바일 단위 테스트, 일반 `pnpm e2e`, Windows
  패키징, Android API 29/35 검증과 실제 PC Control 화면·입력 확인을 수행합니다.
- 운영자가 선택한 기능 핫픽스 정책에 따라 릴리스 성능 벤치마크와 30분 모바일
  소크는 실행하지 않으며, 새 exact-SHA 성능 비교 결과를 주장하지 않습니다.

자세한 지원 범위와 잔여 위험은
[1.0.7 검증 정책](validation-policy-1.0.7.md)을 확인하세요.

## 배포 파일

- `EZTerminal-Setup.exe`
- `EZTerminal-Android-1.0.7-vc28.apk`
- `release-manifest.json`
- `SHA256SUMS.txt`
- `sbom.cdx.json`
