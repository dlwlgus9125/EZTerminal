# UX reference 상태표

이 폴더의 하위 폴더가 지금 어떤 역할을 하는지 적는다. 규범 계약은
[`DESIGN.md`](../../../DESIGN.md)와 [`frontend-design.md`](../frontend-design.md)가 소유하고,
이 폴더는 시각 비교 기준과 지난 승인 기록만 담는다.

| 폴더 | 상태 | 역할 |
|---|---|---|
| [`2.0/`](2.0/manifest.json) | **활성 기준** | 2.0 UX 개편(ux2)에서 사용자가 승인한 화면. 승인 항목마다 production story, visual snapshot, 실앱 캡처 SHA-256, 승인 기록을 고정한다. `scripts/guard-design-reference.mjs`가 검사한다. |
| [`desktop-handoff/`](desktop-handoff/manifest.json) | **보관(1.0 oracle)** | 1.0 상용 UI 핸드오프 원본. byte 단위로 그대로 두며 `desktop-handoff/manifest.json`의 SHA-256 고정이 그 증거다. 14개 surface는 2.0 승인 화면이 대체할 때까지 `2.0/manifest.json`의 `legacy` 항목으로 계속 검사된다. 수정하거나 이동하지 않는다(`.gitattributes`가 이 경로를 `eol=lf`로 고정). |
| `v2/` | 보관 | 2.0 r6 설계 패키지(2026-10-13 승인)와 HTML 검토 포털. 화면별 검토 없이 일괄 승인된 기록이다. |
| `v2-agent-chat-r1/` ~ `r4/` | 보관 | 에이전트 채팅·기획 흐름 정적 프로토타입. r4만 승인됨. |
| `v2-conversation-r6/`, `v2-conversation-r7/` | 보관 | 대화 중심 작업 공간 hosted 시안. R7.1 승인. |

## 갱신 규칙

- `desktop-handoff/` 원본은 수정하지 않는다.
- `2.0/` 승인 항목과 그 캡처는 사용자가 승인한 결정 기록(`docs/ux/overhaul/approvals.md`)이 있을 때만
  추가·교체한다. Snapshot은 승인 기준과 나란히 검토한 경우에만 갱신한다.
- 승인 항목 하나는 다음을 모두 갖춰야 가드를 통과한다: production story export, `visual/storybook.visual.spec.ts`의
  `designReferenceCases` 안 literal case 하나(storyId·screenshot·readySelector·locale·viewports 2개 이상)와 그 목록을
  도는 테스트(두 언어 렌더·두 언어 axe·screenshot·Tab/Shift+Tab 초점 이동·viewport별 가로 넘침 검사), 실앱 캡처
  SHA-256, 실제 날짜의 `decidedAt`, 그리고 승인 기록 anchor 절 안에 그 항목 id를 담고 마지막 칸(답)이 채워진 표 행.
- 1.0 surface는 그것을 대체하는 2.0 승인 항목의 `replaces`에 들어갈 때만 `legacy`에서 빠진다.
