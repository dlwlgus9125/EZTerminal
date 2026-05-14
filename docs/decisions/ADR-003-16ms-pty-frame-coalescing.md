# ADR-003: 16ms PTY Data Frame Coalescing

## Status
Accepted

## Context
PTY는 바이트 단위로 데이터를 출력할 수 있다. 매 바이트마다 IPC 호출하면 대량 출력(ls -la, cat large_file) 시 수천 번의 IPC 왕복이 발생하여 심각한 성능 저하. VS Code 터미널이 동일 패턴을 사용하여 검증됨.

## Decision
main process에서 PTY stdout을 16ms (1 frame @ 60fps) 간격으로 버퍼링한 후 단일 IPC 메시지로 renderer에 전달. setInterval 또는 queueMicrotask 기반.

## Consequences
- Positive: IPC 호출 횟수 대폭 감소, 대량 출력 시 부드러운 렌더링, VS Code에서 검증된 패턴
- Negative: 최대 16ms 지연 (사용자 인지 불가), 프레임 합치기 로직 추가 복잡도
- Follow-up review trigger: key-to-pty latency가 16ms를 초과하면 coalescing 전략 재검토
