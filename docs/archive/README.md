# EZTerminal 문서 아카이브

> 문서 상태: **비규범 역사 기록**

이 디렉터리는 구현 전에 작성된 계획, 게이트 리뷰, 조사 결과와 이전 설계 원본을
보존한다. 현재 제품 동작이나 변경 수용 기준을 판단할 때는
[`docs/architecture.md`](../architecture.md)와 활성 계약 문서를 우선한다. 아카이브의
상태 문구, 버전, 테스트 수치와 미구현 목표는 당시 기록이며 현재 사실로 해석하지
않는다.

## 현재 문서 대응표

| 아카이브 원본 | 현재 계약 |
| --- | --- |
| `design/shell-core-architecture.md` | [`architecture.md`](../architecture.md), [`terminal-runtime.md`](../design/terminal-runtime.md) |
| `design/pty-backpressure-design.md` | [`terminal-runtime.md`](../design/terminal-runtime.md) |
| `design/scripting-design.md` | [`terminal-runtime.md`](../design/terminal-runtime.md) |
| `design/ssh-remote-design.md` | [`terminal-runtime.md`](../design/terminal-runtime.md) |
| `design/layout-persistence-design.md` | [`workbench-lifecycle.md`](../design/workbench-lifecycle.md) |
| `design/mobile-remote-control-design.md` | [`remote-terminal.md`](../design/remote-terminal.md) |
| `design/remote-desktop-design.md` | [`remote-desktop.md`](../design/remote-desktop.md) |
| `design/openclaw-management-design.md` | [`external-integrations.md`](../design/external-integrations.md) |
| `design/frontend-design.md` | [`frontend-design.md`](../ux/frontend-design.md) |

`research/` 아래 파일은 위 설계의 조사·검토 근거다. 활성 코드나 문서에서 현재
계약의 근거로 아카이브를 직접 참조하지 않고, 필요한 결정 이유를 활성 계약에
요약한 뒤 이 기록을 역사적 배경으로만 연결한다.
