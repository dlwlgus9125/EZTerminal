# ADR-006: Visibility Lifecycle Pattern for Collectors

## Status
Accepted

## Context
시스템/네트워크 메트릭 수집기는 CPU를 지속적으로 소비한다. BAK 구현에서 검증된 패턴: 패널이 보이는 동안만 수집하고, 숨기면 중지한다. 이 패턴은 Spec 2 (MetricsService)와 Spec 3 (NetworkService) 양쪽에서 사용되며, 플로팅 윈도우 상태까지 고려해야 한다.

## Decision
`useVisibilityLifecycle` 공유 훅으로 패널 가시성(열림/닫힘) + 윈도우 상태(활성/최소화/닫힘/플로팅) 조합에 따라 수집기를 start/stop한다. 메인 윈도우 최소화 = stop, 플로팅 윈도우 최소화 = 해당 패널만 stop, shutdown 중 재시작 차단.

## Consequences
- Positive: 불필요한 CPU/메모리 소비 방지, BAK에서 검증된 패턴
- Negative: 가시성 상태 조합이 복잡 (패널 open/close × 윈도우 active/minimized/closing × floating), 상태 머신 테스트 필요
- Follow-up review trigger: 새 패널 타입 추가 시 훅이 모든 가시성 상태를 올바르게 처리하는지 검증
