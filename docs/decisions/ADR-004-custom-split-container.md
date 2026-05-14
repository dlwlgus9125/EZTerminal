# ADR-004: Custom SplitContainer over allotment

## Status
Accepted

## Context
페인 분할 UI에 allotment 라이브러리를 검토했다. allotment은 flat 모델(수평/수직 리스트)을 제공하며, 이진 트리 구조의 비대칭 분할을 네이티브로 지원하지 않는다. EZTerminal은 VS Code 스타일의 이진 트리 분할(가로/세로 중첩, 비대칭 비율)이 필요하다.

## Decision
CSS Grid 기반 커스텀 SplitContainer를 구현한다. LayoutNode 이진 트리를 재귀적으로 CSS Grid로 렌더링하며, 6px gutter drag로 비율 조정을 지원한다. 최대 4페인까지 지원.

## Consequences
- Positive: 이진 트리의 자유로운 비대칭 분할, 구현이 LayoutNode와 1:1 대응, 외부 의존성 없음
- Negative: gutter drag, 키보드 접근성, 리사이즈 성능 등 직접 구현 필요
- Follow-up review trigger: 분할 깊이 4+ 지원이 필요해지면 성능/UX 재검토
