# ADR-005: Persist xterm.js Instances via display:none

## Status
Accepted

## Context
탭 전환 시 xterm.js Terminal 인스턴스를 처리하는 두 가지 전략이 있다: (A) display:none으로 숨겨 유지, (B) 매번 재생성. 재생성은 PTY 재연결과 버퍼 복원이 필요하며 사용자에게 인지 가능한 지연이 발생한다. 반면 유지 전략은 WebGL 컨텍스트가 누적되어 GPU 한계(일반적으로 16개)에 도달할 수 있다.

## Decision
xterm.js 인스턴스를 탭 전환 시 display:none으로 유지한다. WebGL 컨텍스트 한계 도달 시(webglcontextlost 이벤트) 해당 인스턴스를 Canvas 2D로 전환한다 (ASR-7). 실사용에서 16탭 도달 빈도가 낮고, 도달하더라도 Canvas 폴백으로 기능 손실 없이 성능만 저하.

## Consequences
- Positive: 탭 전환 즉시, PTY 재연결/버퍼 복원 불필요, 스크롤 위치 보존
- Negative: WebGL 컨텍스트 누적, 메모리 사용량 탭 수에 비례 증가
- Follow-up review trigger: 사용자가 16+ 탭을 일상적으로 사용하는 패턴이 확인되면 LRU 디스포즈 전략 검토
