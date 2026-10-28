# ux2: 2.0 디자인·UX 흐름 전면 개편 기록

2026-10-23 시작한 개편의 진행 기록이다. 규범 계약은 [`DESIGN.md`](../../../DESIGN.md)와
[`frontend-design.md`](../frontend-design.md)가 소유하고, 이 폴더는 개편이 끝날 때까지의 전환 기록만 담는다.

## 확정된 요청 (2026-10-23 사용자 확인)

- 데스크톱과 Android를 처음부터 함께 개편한다. 모든 기능은 계속 도달할 수 있어야 하고, 자리·진입점·화면 구성은
  자유롭게 바꾼다.
- 대표 느낌은 Matrix/터미널 정체성(녹색 신호, CRT 효과, EZTerminal 워드마크·display 글꼴, CLI 스킨 문법, 터미널
  블록)이다. 다른 테마는 이 정체성의 구조·타이포·크롬 문법을 이어받는다. 새 설치 기본값은 Matrix다.
- 우선순위: 기능 간 흐름 → 보이는 완성도 → 크롬이 작업 공간을 차지하는 문제 → 화면마다 다른 문법.
- 최적화할 여정: AI 대화로 개발(주력) → 소프로젝트 흐름 설계·실행 → 폰에서 확인·승인·이어가기.
- 데이터·엔진·원격 프로토콜은 필요하면 바꾼다. 실제 프로필의 프로젝트·대화·설정은 마이그레이션으로 보존하고,
  구형 APK가 새 PC와 연결되지 않는 것은 허용한다.
- 성능 최적화와 남은 엔진 버그는 별도 단계(3단계)로 두고 개편 중에는 기록만 한다.

## 진행 방식

관문 3개와 화면별 승인. 모든 승인은 실제 컴포넌트·실제 세션 시안 → 어드바이저와 Codex 검수 → 수정 →
사용자 승인(결정 목록에 답하는 형태) → 실제 앱(격리 프로필)과 Android API 29/35 확인 → 머지 순서를 따른다.

| 관문 | 내용 | main 머지 |
|---|---|---|
| ① 구조·흐름 | 기준선 측정, 진입점 통합표, 목표 IA와 새 UX 계약, Storybook 셸 골격(A/B) | 문서·가드·검증 도구만 |
| ② 디자인 언어 | Matrix 기준 디자인 언어, 새 셸(기존 화면을 그대로 담음), 시범 화면, Matrix 기본값 | 첫 제품 코드 |
| ③ 흐름 묶음 | B1 대화 → B2 결과·검토·파일 → B3 프로젝트·소프로젝트 → B4 원격·폰 → B5 터미널·도구·정리 | 묶음마다 |

**끝남 (2026-10-28).** 관문 ②부터는 구현 계획 v2의 단계로 진행했다: I1 셸(Board + Desk) → I2 흐름 → I3 터미널 →
I4 Android → I5 정리(도구 화면 12개 승인, 아이콘 전부 glyph, 옛 기획 패널·1.0 틀 삭제, 1.0 legacy 0). 묶음 B1–B5의
내용은 이 단계들에 나뉘어 들어갔고, 화면별 답은 [`approvals.md`](approvals.md)에 있다.

## 문서

- [`journeys-baseline.md`](journeys-baseline.md): 개편 전 크롬 점유와 주요 여정 단계 수
- [`entry-points.md`](entry-points.md): 진입점 통합표와 관문별로 다시 쓸 테스트
- [`success-signals.md`](success-signals.md): 성공 신호와 임계값
- [`approvals.md`](approvals.md): 관문·화면별 사용자 결정과 검수 기록
- 기준 화면: [`../reference/2.0/manifest.json`](../reference/2.0/manifest.json), 상태표
  [`../reference/README.md`](../reference/README.md)
- 개편 전 UX 계약 원문: [`../reviews/2026-10-23-ux2-baseline/frontend-design.md`](../reviews/2026-10-23-ux2-baseline/frontend-design.md)
