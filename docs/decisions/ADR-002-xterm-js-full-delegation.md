# ADR-002: xterm.js Full Delegation

## Status
Accepted

## Context
BAK 구현은 자체 VtParser + TerminalBuffer + TerminalRenderer를 가지고 있었다. Electron 전환 시 xterm.js가 VT 파싱, 버퍼 관리, WebGL/Canvas 렌더링을 모두 제공한다. 자체 VT 파서를 유지하면 xterm.js와 이중 구현이 되어 유지보수 부담이 크다.

## Decision
VT 렌더링을 xterm.js에 전적 위임. 자체 VT 파서/버퍼/렌더러 구현하지 않음. xterm.js addon 생태계 활용 (fit, search, WebGL, unicode11). 터미널 기능 확장은 xterm.js addon API를 통해서만 진행.

## Consequences
- Positive: VT 호환성 즉시 확보 (xterm.js = VS Code 수준), 유지보수 대폭 감소, 커뮤니티 버그픽스 자동 흡수
- Negative: xterm.js 한계에 종속 (커스텀 VT 확장 불가), xterm.js 메이저 버전 업그레이드 시 breaking change 위험
- Follow-up review trigger: xterm.js가 필요한 VT 시퀀스를 지원하지 않을 때
