# EZTerminal 2.0.0 validation policy

- Desktop / Android / native host: `2.0.0`
- Android versionCode: `77`
- Remote protocol: `v16`; v15/v14/v13/v12 clients retain compatible legacy operations.
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

성능 측정은 요청되지 않았으므로 실행하지 않는다. 이 버전의 성능 또는 soak 인증을 주장하지
않으며, 자동으로 Git merge/push, 설치, 공개 발행하지 않는다.
