# 리뷰 루프 구현 기록 (Claude 데스크톱 기능 흡수 1묶음)

상태: 구현과 로컬 검수 완료. 공개 배포나 설치판 확인을 뜻하지 않는다.
계약: [frontend-design](../frontend-design.md) §7·§15·§22·§23·§24, [agent-collaboration "검토 루프"](../../design/agent-collaboration.md).
결정 기록: [approvals.md "리뷰 루프"](../overhaul/approvals.md). 브랜치 `feat/review-loop`(기준 `d9e7195`).

## 요청과 범위

사용자 요청(deep-interview로 확정, 2026-10-29): Claude 데스크톱 v4.29.0(2026-10-27) Code 탭 기능 중 EZTerminal에 없는 것을
"구색 맞추기가 아니라 제대로" 4묶음으로 가져온다(리뷰 루프 → 턴 마무리 → 장시간 연속성 → 내장 브라우저 검증). 이 기록은 1묶음이다.

- 대화 속 "AI 검토 결과" 카드: 파일·줄별 문제, 하나씩 보기, 이것만 고치기·무시·다시 열기·모두 고치기.
- 리뷰어: 기본은 이 대화의 AI(대화의 읽기 전용 분기), 메뉴에서 다른 AI(읽기 전용 별도 대화). 고치기는 늘 원래 대화의 턴.
- diff 코멘트 한 번에 보내기, 워크트리 대화의 기준 브랜치 비교, 폰은 카드·문제 보기 시트·코멘트까지.
- 하지 않은 것: 클라우드·claude.ai 계정 기능, PR·CI, 자동 리뷰, 폰 알림.

## 실험으로 정한 방식

실제 Claude CLI 2.1.312·SDK 0.3.260, Codex 0.165.0으로 먼저 실험했다(`scripts/probe-*review*`, 보고는 로컬 `artifacts/review-findings-probe/`).

- Claude `/code-review`의 `ReportFindings`는 Claude 자체 호스트에서만 켜져 SDK 호스트에는 글만 온다. Codex `review/start`는 글과 절대
  경로뿐이다 → 두 AI 모두 EZTerminal이 만든 diff를 인용 데이터로 넘기고 정해진 JSON으로 답하게 한다.
- 결과 형식 강제(Claude `outputFormat`, Codex `outputSchema`)가 프롬프트 캐시를 깬다(대조 실험 2회: 분기 그대로 ~100%, 형식 강제 0%).
  사용자가 btw와 다르다고 짚어 다시 잰 결과다 → 같은 AI 검토는 형식 강제 없이 JSON 텍스트로 답하게 하고, 형식이 틀리면 형식 강제 분기로 한
  번만 다시 돌린다. 다른 AI 검토는 다시 쓸 캐시가 없어 형식 강제.
- 읽기 전용: Claude 리뷰어는 `Read·Grep·Glob`만, MCP 없음(`strictMcpConfig`, 서버 없음; 캐시 유지 확인), 승인 창 없음. Codex는 읽기 전용
  샌드박스 + 승인 안 함 + 사용자 설정 MCP 서버를 그 스레드에서만 끔. 남는 한계: Codex 앱 커넥터의 읽기 전용 표시 도구.

## 구현

- **공용 모델** `src/shared/review-findings.ts`: 스키마, 리뷰·고치기 지시(믿지 않는 부분은 모두 인용 데이터), 경로 검사, 결정적 문제 id,
  답 줄 판정(`parseFixReply`), 잘림 표시, 실패 이유 코드. 대화 기록 payload는 `review`·`review-status`·`review-fix`·`review-request`
  (DB 마이그레이션 없음, 옛 클라이언트는 읽을 수 있는 글).
- **호스트**: 데몬 명령 `review.start/fix/resolve/cancel`(데스크톱·폰, MCP 제외), `src/main/review-coordinator.ts`(대기 = 응답 중·대기열
  턴·동시 실행 한도, 15분 시간 제한, 재시작 시 중단 표시, 파일이 바뀌면 표시), 리뷰 diff·워크트리 기준 diff(`git-status-service.ts`),
  어댑터의 `reviewFork`와 읽기 전용 리뷰어, 스냅샷 `review-loop-v1`·`reviewSupport`(버전은 이상 비교).
- **화면**: `ActionCard` 틀 위의 `ReviewCard`(두 스킨), `ReviewStartMenu`(`/review 글`은 초점을 채운 시작 창), 결과물 탭 하나씩 보기(고정 띠)·
  코멘트 보내기·기준 브랜치 비교, 폰 문제 보기 시트(두 번 눌러 범위, 공용 코멘트 트레이, 44px). 리뷰 capability가 없는 옛 호스트는 옛 흐름.

## 검수

- 시안: Storybook `Production/ReviewLoop/*` 51화면, 어드바이저 + Codex gpt-6-astra max 2회(반드시 고침 7건 + 잔여 5건 모두 실패 테스트부터).
- 실제 응답 fixture: Claude·Codex 리뷰 분기(형식 강제·JSON 텍스트)와 리뷰어 대화를 녹화해 어댑터 재생 테스트로 고정.
- 실검증(실제 Claude·Codex, 격리 프로필): 10개 시나리오 통과 — 같은 AI 두 AI, 교차 리뷰 두 방향, 하나 고치기(답 줄로 고침 판정), 응답 중
  모두 고치기 대기열, 무시 새로고침, 코멘트 보내기, 기준 브랜치 비교, "검토…" 메뉴. 리뷰 11–32초, 리뷰어 쓰기 0.
  여기서 찾아 고친 것: 끝난 리뷰어 대화가 이어 보낼 수 있는 초안으로 열림(이제 읽기 전용, 이어가기 거부), 시작 창의 모델 표시가 늦게 바뀐 연결을
  못 읽음, 하나씩 보기 띠가 화면 밖으로 밀림, 좁은 읽기 전용 대화 머리줄 넘침, 대기열 칸의 영어 고치기 지시문 등.
- Android: `mobile/e2e/review-journey.ts`가 API 35·API 29(WebView 74)에서 통과, 쓴 조작 22개 모두 44px 이상. 폰이 턴 기록을 넘기지 않아
  고침 상태가 멈추던 것을 고쳤다.
- 최종 게이트 수치는 아래 "최종 검사"에 적는다.

## 계획과 달라진 것

- 같은 AI 리뷰: "원래 대화의 턴" → "원래 대화의 읽기 전용 분기"(대화의 권한·기록·대기열을 건드리지 않음).
- 결과 한도: 본문 600·문제 상황 500자(계획 1,000/2,000). 잘리면 안내와 원문 보기.
- D14: 비용 안내와 "대화 맥락 없이 검토"를 뺐다(캐시를 깨는 원인이 형식 강제였음).

## 남은 것과 범위 밖에서 찾은 것

- 범위 밖, 따로 고칠 것: 워크트리가 있던 등록 프로젝트 폴더를 지우면 다음 실행에서 데몬이 안전 모드로 들어감(`daemon-project-sync.ts:727`).
  WebView 74에서 공용 메뉴 항목의 아이콘이 글자 위로 쌓임, 코드로 옮긴 초점에 테두리가 보임, 라디오 점이 회색.
- 폰 문제 보기 시트의 "파일에서 보기"는 Android가 `onOpenProjectFiles`를 연결하지 않아 아직 없다.
- 실제 대화가 아주 긴 경우의 리뷰 품질·시간은 작은 저장소로만 확인했다.

## 최종 검사

2026-10-30, 프로젝트 맵 재고정(`d78a9dd`) 뒤 소스 확정 상태에서 한 번에 돌렸다(`artifacts/review-loop/final-gates/gates.log`, 로컬).

- `pnpm typecheck`, `pnpm lint` 통과.
- `pnpm test` 통과: docs:check(링크 415), Project Map check(7개 맵), 단위 4,783(건너뜀 5), OS 90, 가드 전부(design-reference 2.0 화면 32개 포함).
- `pnpm test:storybook` 545 통과. `pnpm -C mobile typecheck`·`test`(686)·`lint` 통과.
- `pnpm test:visual` 87개 중 1개(하네스 설정 기준 화면)가 승인 결정에 따른 문구 변경("검토 맡기기" → "검토… › 다른 AI로 검토")으로 달라져,
  승인 캡처와 나란히 본 뒤 그 스냅샷만 갱신(`ad81450`). 승인 캡처 원본은 그대로.
- `pnpm e2e` 177개 중 176 통과, 1개는 리뷰 e2e가 실검증 뒤 바뀐 대기열 표시(영어 지시문 대신 "Fix review findings · 1")를 반영하지 않은 것 →
  테스트를 고쳐 그 spec 3/3 통과(`ad81450`). 성능 측정은 돌리지 않았다.
- 2.0 기준 화면 6개를 실앱·API 35 캡처로 고정(`596d6ff`): `review-card`, `review-card-cli`, `review-start`, `review-walkthrough`,
  `review-phone-card`, `review-phone-sheet`.
