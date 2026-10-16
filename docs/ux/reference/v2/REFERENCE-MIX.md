# 참고 제품을 결합하는 방식

Manyfast의 기획 흐름과 Orca의 AI 작업·결과 검토 경험을 하나의 프로젝트 맥락으로 연결한다. 아래의 EZTerminal 동작은 이번 설계 제안이며, 참고 제품이 같은 구현을 제공한다는 뜻은 아니다.

| 참고 축과 근거 | EZTerminal 2.0의 결합 방식 | 명세·화면 |
| --- | --- | --- |
| [Manyfast의 연결된 기획](https://docs.manyfast.io/plan/plan), [기능명세](https://docs.manyfast.io/plan/features) | PRD·기능·수용 기준·흐름·화면을 ID와 버전으로 연결하고, 변경 영향을 실행 작업까지 전달 | F04–F05 · D05–D08 |
| [Manyfast의 와이어프레임](https://docs.manyfast.io/plan/wireframe) | 화면을 검토하고 직접 편집·체험. 선택 요소에 대한 AI 수정과 Android 속성 폼으로 확장 | F06 · D09–D12, M06 |
| [Manyfast의 내보내기](https://docs.manyfast.io/use/export) | 기획 원본을 프로젝트에 보관하고, 확정 버전을 문서·화면·검토 패키지로 전달 | F07, F13 · D13, D25 |
| [Orca의 AI 작업 공간](https://github.com/stablyai/orca), [worktree](https://www.onorca.dev/docs/model/worktrees) | 대표 AI가 확정 설계의 작업을 배정. 각 작업은 범위·의존성·작업 사본·검증 근거를 가짐 | F08 · D15–D19 |
| [Orca의 native chat](https://www.onorca.dev/docs/agents/native-chat) | 구조화된 대화와 도구 결과를 두 스킨으로 표현하고, 산출물·작업·실제 터미널을 연결 | F02, F14 · D18, D36–D37, M04 |
| [Orca의 Design Mode](https://www.onorca.dev/docs/browser/design-mode) | 실행 결과에서 선택한 요소를 수정 요청에 첨부하고, 새 변경과 검증을 원래 수용 기준에서 다시 검토 | F09 · D20–D24 |
| [기존 EZTerminal UX 계약](../../frontend-design.md) | 터미널·원격·PC 제어·파일·모니터·OpenClaw·자동화의 기존 수명과 입력 계약을 유지 | F10–F12 · [기존 기능 대응표](LEGACY-COVERAGE.md) |

## 제품 전체를 잇는 연결

[Orca Orchestration](https://www.onorca.dev/docs/cli/orchestration)의 작업자별 모델·추론 옵션과 실행 시도·메시지 구조, [병렬 비교](https://www.onorca.dev/docs/recipes/parallel-agents)의 동일 기준 후보 비교를 [AI 운영 설계 보강안](AI-OPERATING-MODEL.md)에 연결했다. 단계별 제품 기획 프롬프트와 제한된 기획 편집 권한은 EZTerminal의 추가 설계다. 역할 템플릿은 [AI-PROFILES.md](AI-PROFILES.md)에 있으며, 특정 모델을 고정 추천하지 않는다.

예를 들어 “말풍선과 터미널형 대화를 모두 지원한다”는 요구사항은 F02와 D18/M04에 연결된다. 사용자가 화면을 검토하면 그 버전이 설계 기준에 포함된다. 대표 AI의 작업 T04는 그 기준과 수용 조건을 입력으로 받는다. 실행 결과를 검토할 때는 해당 작업의 변경·화면·검증이 같은 요구사항에 모인다.

이후 입력 영역을 바꾸면 연결 화면과 수용 조건을 재검토한다. 진행 중 작업의 기준 버전은 그대로 보존하고, 새 기준으로 옮길 작업만 재계획한다. 이를 위한 데이터 경계는 [설계 구조](ARCHITECTURE.md), 사용 경험은 [8개 흐름](FLOWS.md)에 정의했다.

## 별도 로드맵 기능에 대한 판단

현재 목적은 개인이 하나의 제품을 기획하고 실행하는 것이다. 필요한 정보인 선행 작업·담당·진행·검토 지점은 작업 화면에 이미 들어간다. 독립 로드맵은 같은 정보의 별도 편집·동기화 비용을 만들며 이번 요구를 해결하는 데 필수적이지 않다.

따라서 이번 제작의 단계·의존성·완료 기준은 [제작 로드맵](ROADMAP.md)으로 제공한다. 제품의 독립 로드맵 메뉴·간트차트·저장 모델은 제외한다. 다중 제품의 장기 릴리스·자원 계획 요구가 생기면 별도 기능으로 재평가한다.

## 범위 경계

참고 제품의 모든 메뉴를 그대로 복제하지 않는다. 대신 기획 → 화면 → 확정 → 실행 → 검토 → 변경 영향의 전체 연결을 이번 명세의 완료 기준으로 삼는다. 사용자에게 합의한 Windows·Android, 실제 터미널, 기존 도구는 이 연결에 함께 포함된다. 별도 서비스 클라우드와 자체 실시간 공동 편집은 현재 범위 밖이다.
