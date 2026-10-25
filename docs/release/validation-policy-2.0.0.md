# EZTerminal 2.0.0 validation policy

- Desktop / Android / native host: `2.0.0`
- Android versionCode: `78`
- Remote protocol: `v17`; v16 clients get a reduced flow view without the v17 fields (stage effort, run settings, repeat, stage bindings) and cannot make flow edits that would drop them; v15/v14/v13/v12 clients retain compatible legacy operations.
- Native desktop protocol: `v2`
- Validation profile: `functional-hotfix` (기존 기능 검증 파이프라인 식별자)
- Windows signing mode: `unsigned`

이 문서는 개발 후보의 검증 조건이며 공개 출시 인증서가 아니다. 작업 트리에는 기존 사용자
변경과 이번 구현이 함께 있으므로 HEAD만으로 산출물의 전체 소스를 식별하지 않는다.
패키지 보고서에 작업 트리 상태·입력 해시와 산출물 SHA-256을 함께 남긴다.

필수 검사는 타입·단위·OS·일반 Electron E2E, Android production build와 WebView74,
Storybook 접근성·시각 점검, 버전 계약과 패키지 실행이다. 최종 통과·실패·미실행 근거는
[구현 진행 기록](../ezterminal-v2-implementation.md)을 따른다.
Android 설치·업데이트·IME·재연결·강제 종료 검증은 연결된 기기가 필요하다.
미실행 항목이 남으면 G8 출시 준비 완료로 표시하지 않는다.

의존성 감사 예외(기한 있음): 원격 호스트의 `crypto-bigint 0.5` 타이밍 권고 RUSTSEC-2026-0387은 고정된 webrtc 0.17 →
dtls → p256/p384 → elliptic-curve 0.13을 거쳐서만 들어오며(기기 페어링 뒤 원격 데스크톱 DTLS 핸드셰이크), 고치려면 webrtc
0.21(구조를 새로 짠 판)로 옮겨야 한다. `native/remote-host/deny.toml`·`.cargo/audit.toml`에 사유와 함께 예외로 두고
2026-12-01까지 원격 호스트 webrtc 전환으로 다시 본다. 같은 때 tokio 1.54.1(RUSTSEC-2026-0386)·dtls 0.17.2로 올렸다.

성능 측정은 요청되지 않았으므로 실행하지 않는다. 이 버전의 성능 또는 soak 인증을 주장하지
않으며, 자동으로 Git merge/push, 설치, 공개 발행하지 않는다.
