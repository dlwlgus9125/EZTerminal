# ADR-007: Npcap Graceful Degradation

## Status
Accepted

## Context
패킷 캡처는 cap 라이브러리(Npcap 필수)로 구현한다. Npcap은 사용자 PC에 별도 설치가 필요하며, 일부 환경에서는 관리자 권한이 요구된다. 터미널 에뮬레이터의 핵심 기능은 터미널이며, 네트워크 모니터링은 부가 기능이다. Npcap 미설치로 앱 자체가 실행 불가하면 안 된다.

## Decision
Npcap 미설치 시 graceful degradation:
1. 패킷 캡처 기능 비활성 (UI disabled + 설치 안내)
2. 트래픽 그래프는 systeminformation.networkStats() 폴백으로 제공 (정밀도 낮지만 동작)
3. 연결 테이블은 netstat 기반으로 독립 동작 (Npcap 불필요)
4. Npcap 감지 결과를 startup 로그에 기록

두 데이터 소스(cap vs systeminformation)는 정밀도가 다르다. cap은 실시간 패킷 수준, systeminformation은 OS 카운터 기반 초당 집계. UI에 데이터 소스를 명시하지 않으며, 사용자에게 투명하게 전환.

## Consequences
- Positive: Npcap 없이도 앱 + 네트워크 기본 기능 정상 동작, 설치 UX 개선
- Negative: 두 데이터 경로 유지보수, systeminformation 폴백의 정밀도 차이 (사용자 혼란 가능성 낮음)
- Follow-up review trigger: cap이 Npcap 없이 동작하는 대안(WinDivert 등)을 지원하면 재검토
