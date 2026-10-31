# 턴 마무리 구현 기록 (Claude 데스크톱 기능 흡수 2묶음)

상태: 구현과 로컬 검수 완료. 공개 배포나 설치판 확인을 뜻하지 않는다.
계약: [frontend-design](../frontend-design.md) §7·§14·§22·§23, [agent-collaboration "턴 마무리"](../../design/agent-collaboration.md#턴-마무리).
결정 기록: [approvals.md "턴 마무리"](../overhaul/approvals.md#2026-10-30-턴-마무리claude-데스크톱-기능-흡수-2묶음-실험-결정). 브랜치 `feat/turn-wrap-up`(기준 `19047d61`).

## 요청과 범위

사용자 요청(2026-10-29 확정): 요약 카드, 다음 입력 제안(Tab 수락), 제안 작업 카드(새 하위 대화로 시작·워크트리 선택, 여기서 하기, 모두 시작). AI는 제안만 하고 실행은 사람이 누를 때만.
자동 AI 호출은 싼 것만, 한도 근처면 멈춤, 모두 설정에서 바꿀 수 있음.

- 다음 입력 제안: Claude 자체 기능, Codex 읽기 전용 분기(노력 low). 데스크톱은 입력창의 흐린 글과 Tab, 폰은 입력창 위 칩.
- 요약 카드: 아무 화면도 그 대화를 보지 않을 때 턴이 끝나거나 AI가 멈춰 기다리면 턴마다 한 번. `/btw` 경로로 만들고 대화에 저장한다.
- 제안 작업 카드: 세션 MCP 도구 `suggest_task`, 턴당 8개, 모두 시작, 폰은 이 폴더에서만.
- 하지 않은 것: 자동 실행, 폰 설정, 폰에서 새 워크트리, 알림.

## 실험으로 정한 방식

수치와 판단은 [approvals.md](../overhaul/approvals.md)의 실험 결정·구현 전 추가 실험이 소유한다(`scripts/probe-*-turn-wrap-up.mjs`, 보고는 로컬 `artifacts/wrap-up-probe/`). 구현을 가른 것만 적는다.

- Codex는 예측 기능이 없어(`thread/prediction/request` 미구현) 분기로 만든다.
- 멈춘 턴의 Codex 분기에는 `<turn_aborted>`가 붙어, 앱이 무엇이 열려 있는지 말해 주지 않으면 "중단됨"이라고 쓴다.
- `thread/resume`의 지시는 무시되고 `turn/start`의 `additionalContext`는 듣는다. Claude 제안의 실행 중 스위치는 env뿐이고 `promptSuggestionEnabled`는 효과가 없는데도 켜진 것처럼 보고한다.

## 구현

- **공용 모델** `src/shared/turn-wrap-up.ts`(지시 원문, 한도, 코드, 브랜치 이름, 하위 대화 id), `src/shared/automatic-calls.ts`(자동 호출 목록), `src/shared/conversation-viewing.ts`. 대화 기록 payload 다섯, DB 마이그레이션 없음.
- **호스트**: `src/main/turn-wrap-up-coordinator.ts`(제안·요약·작업 행, 재시작 복구), `src/main/conversation-viewers.ts`(보고 있음 신호), MCP 네 번째 tier, 명령 `wrap-up.recap-retry`·`wrap-up.task-outcome`, `agent.create`·`agent.submit`의 `wrapUpTask`, 설정 파일 `turn-wrap-up.json`, 스냅샷 `turn-wrap-up-v1`·`nextPromptSuggestions`, 버전 하한.
- **화면**: 입력창 제안, `TaskSuggestionsCard`·`RecapCard`, `TaskStartAllDialog`, 설정 절 `TurnWrapUpSettings`, 폰은 같은 카드와 칩(`src/renderer/turn-wrap-up-commands.ts`를 공유).
- **곁에서 고친 것**: 실패한 도구 영어 문구("Tried to called"), 시작 경쟁(수정 번호 충돌 8회 재시도), WebView 74의 도구 줄 쌓임, 빈 워크트리 정리(§14).

## 검수

- 시안: Storybook `Production/TurnWrapUp/Mockup` 56화면, 어드바이저 + Codex gpt-6-astra max 2회(반드시 고침 6건, 권장 3건 모두 실패 테스트부터). 시안 때 정한 17가지와 D1–D9를 사용자가 승인.
- 실제 응답 fixture: Claude 제안, Codex 예측·요약 분기, 두 AI의 `suggest_task`를 녹화해 재생 테스트로 고정.
- e2e: `e2e/turn-wrap-up.spec.ts` 13개(가짜 Codex, 실 MCP 경로).

### 실검증 (실제 Claude·Codex, 격리 프로필)

`scripts/verify-ux-live.mjs`, Claude CLI 2.1.312·SDK 0.3.260, Codex 0.165.0, 보고 `artifacts/turn-wrap-up/live/`(로컬, 46회). 33개 시나리오가 마지막 실행에서 모두 통과했다: 제안 두 AI, 요약(안 볼 때, 보는 동안 없음, 승인·질문·계획에서 멈춤과 답한 뒤), 제안 작업 시작, 여기서 하기 대기열, 모두 시작 새 워크트리, 상한 8개, 설정 스위치, 멈춤, 보기 신호, heartbeat·report-back·검토자·자문 대상 제외, 창 닫고 계속 실행, 기능 이전에 만든 대화 이어가기, `/btw`.

- 제안 표시 시간: Claude 0.9–2.8초(9회), Codex 10.0–13.2초.
- heartbeat 2회에 제안 요청 0, 곁 호출 0. 다음 사람 턴의 제안 요청은 캐시 읽기 35,060(대화 35,064), 캐시를 깨지 않았다.
- 기능 이전 Claude 대화의 이어 쓰기: 캐시 읽기 46,771, 새로 쓰기 84(대화 46,859).
- Codex 분기 비용: 수정(`b40810f8`) 전 분기당 캐시 밖 입력 중앙값 7,261토큰(48회), 뒤 494토큰(29회, 한 번은 6,898). 캐시 비율이 이 차이를 가렸다. `codexReviewForkRequest`에 같은 빈틈이 남아 있다.
- 멈춘 요약의 질문 앞 안내(`6f3234d6`) 뒤 Codex 10회 재측정: 9회 정확, 1회(`stop-7`)는 여전히 "기록상 호출이 중단"이라고 썼다. 수정 전 8/10, 실험 4/4.
- 실제 AI가 스스로 쓴 작업 12개 중 `워크트리 권장` 0개. 그래서 모두 시작의 기본을 바꿨고, 권장 표시는 요청받았을 때만 실제로 보였다.
- 여기서 찾아 고친 것: 멈춘 요약이 끝난 일 아래에서 현재형으로 읽힘, Claude가 75%에서 말없이 제안을 멈춤, 모두 시작이 8개 중 1개를 수정 번호 경쟁으로 잃음, 첫 턴 전에 폰의 대화가 안 보는 것으로 잡힘, 받지 않은 호출이 빨간 실패로 보임, 빈 워크트리를 정리할 수 없음, 영문 단어 없는 제목이 배치 사이에서 충돌, 분기 비용.

### Android

`mobile/e2e/wrap-up-journey.ts`, 가짜 Codex 격리 데스크톱, 360×800, 한국어. 수정 목록 반영 뒤와 최종 소스에서 API 35·API 29(WebView 74)에서 통과(점검 17, 터치 대상 16개 모두 44px 이상, 그림 29장), 기능 이전 PC에 붙은 경우(`--old-host`)는 수정 목록 전에 통과. 칩, 무엇이 보는 것인지(앞의 대화, 앱이 뒤, 다른 화면, 다른 대화, 재연결), 요약과 실패, 답하러 가기, 전체 권한 대화의 작업 시작, 여기서 하기, 무시와 다시 열기, 모두 시작 시트, 긴 단어.

## 계획과 달라진 것

- 멈춘 요약의 자리: 턴 끝 → 멈춘 자리(사용자 답, 2026-10-31).
- 모두 시작의 기본: 이 폴더 → 작업이 둘 이상이면 새 워크트리, 만들 수 없으면 이 폴더(D6 뒤 사용자 답과 구현 판단, approvals.md).
- Claude 제안 env: `''`로 복원 → 켜짐은 늘 `'true'`(CLI의 75% 멈춤을 풀고 앱의 90%만 남김).
- 받지 않은 호출의 이유: host 문장 → 코드로 앱이 쓴 짧은 문구.
- 사람이 보내지 않은 턴은 도착한 제안을 버리는 대신 그 턴의 요청을 막는다(비용을 쓰지 않으려고).

## 재지 못한 것

- 취소된 호출의 과금, 실제로 90%에 닿았을 때의 동작(멈춤은 하네스의 강제 값으로 확인했고, 75% 멈춤만 실제 주간 77%에서 봤다), 한도에 닿았을 때의 CLI.
- `additionalContext` 지시가 압축 뒤에도 남는지, 낮은 노력의 Codex 요약 품질, 붙잡힌 명령·권한·MCP elicitation 요청에서의 분기.
- 요약 시간 초과 경로와 `suggest_task`가 멈춘 턴의 분기에서 불리는 경우는 단위 테스트뿐이다.
- e2e가 다루지 않는 것: Claude 전체, 폰, 팝아웃·분할·`unknown`·창 없음, 두 번째 기기, heartbeat, 보관본 가림. 앞의 셋 일부는 실검증·Android 여정이 다룬다. 보관본 가림은 실제 흐름으로 돌려 보지 않았다.
- 실제 AI가 만든 긴 대화에서의 제안 품질. 제안은 합성 대화에서 본 것이다.

## 남은 것과 범위 밖에서 찾은 것

- 범위 밖, 손대지 않음: `codexReviewForkRequest`의 `tools.update_plan` 빈틈, 턴 도는 중 Codex `/btw`에도 있을 `<turn_aborted>` 거짓, 옛 `overflow-wrap: anywhere` 112곳, 폰의 전송 뒤 빨간 줄, 아래 플레이크.
- `pnpm e2e` 플레이크: `agent-management:45`와 `project-workbench:379`는 기준 `19047d61`에서도 재현(각 6번 중 1번). `agent-management:115`는 이 브랜치에서 13번 중 1번, 기준에서 6번 중 0번으로 원인이 증명되지 않았다(이 브랜치가 바꾸지 않은 경로).
- 설정 사이드바 기본 폭 320px에서는 `턴 마무리` 설명 열이 약 65px로 좁다. 기존 배치이고 사람이 넓힐 수 있다.

## 최종 검사

2026-10-31, 프로젝트 맵 재고정(`48390097`) 뒤 소스 확정 상태에서 차례로 돌렸다(`artifacts/turn-wrap-up/final-gates/`, 로컬).

- `pnpm typecheck`, `pnpm lint` 통과.
- `pnpm test` 통과: docs:check(링크 428), Project Map check(7개 맵), 단위 5,214(건너뜀 5), OS 97, 가드 전부(design-reference 2.0 화면 41개 포함).
- `pnpm test:storybook` 609 통과. `pnpm test:visual` 96 통과(새 기준 9개, 기존 스냅샷 변화 없음). `pnpm -C mobile typecheck`·`lint`·`test`(705) 통과.
- `rm -rf .vite` 뒤 `pnpm e2e` 190개 중 189 통과, 1개 실패 — 초록이 아니다. 실패는 `project-workbench:379`로 파일 패널이 외부 폴더로 이동하지 않은 것이다. 기준 `19047d61`에서도 재현한 플레이크이고 그 spec과 파일 패널 코드는 이 브랜치에서 바뀌지 않았다. 그 spec만 따로 5번 돌리면 4 통과 1 실패다. `agent-management:45`·`:115`는 이번에 실패하지 않았다.
- `pnpm test:e2e:packaged` 8 통과. 이 8개는 턴 마무리 경로를 지나지 않아, 같은 패키지 EXE에서 가짜 Codex로 따로 확인했다(커밋하지 않은 spec): `turn-wrap-up-v1`, MCP `suggest_task`(카드 8개, 아홉째는 앱 문구로 거절), 한 번 눌러 시작한 하위 대화(`승인 후 실행`), 예측 분기의 제안, 저장된 요약. Claude SDK 경로는 패키지 EXE에서 돌리지 않았다. 가짜 Claude가 없어, SDK가 `main.js`에 번들되어 있는 것과 `guard:claude-provider`까지만 봤다.
- 최종 소스의 APK로 `mobile/e2e/wrap-up-journey.ts`를 API 35·API 29(WebView 74)에서 다시 돌려 통과했다.
- 2.0 기준 화면 9개를 실앱·API 35 캡처로 고정(`17c372ed`): `turn-suggestion`, `turn-recap`, `turn-recap-cli`, `task-card`, `task-card-cli`, `task-start-all`, `wrap-up-settings`, `task-phone-card`, `suggestion-phone-chip`.
- 이 수치를 적은 문서 커밋 뒤 `pnpm test`를 다시 돌렸다. 성능 측정은 돌리지 않았다.

## 3묶음 전 후속 (2026-10-31)

브랜치 `fix/wrap-up-followups`(기준 `83cb3096`). 사용자가 승인한 세 건만 고쳤고 다시 설계한 것은 없다. 계약: [frontend-design](../frontend-design.md) §7·§23. 보고는 로컬 `artifacts/wrap-up-followups/`.

### 폰 칩이 화면을 밀던 문제

칩은 입력창 안 배치에 있어, 턴이 끝나고 몇 초 뒤 오면 대화 목록이 54px 줄고 꼬리를 따라가던 대화가 그만큼 올라갔다. 제안 작업 버튼으로 가던 손가락이 다른 줄을 눌렀다. 치우면 54px 돌아왔다.

- **고침**: 칩을 배치에서 빼 대화 목록 아래쪽에 띄웠다. 칩의 상태와 동작은 입력창이 그대로 갖고 포털로 그리는 자리만 옮겼다. 자리는 `ChatViewport` 안이라 덮는 것은 대화 목록뿐이고, 할 일·결정 도크, 하위 대화 줄, 초안 줄은 그 아래에 그대로 있다. 입력창에 붙이는 안은 그 줄들을 가리므로 버렸다.
- **스크롤 여백**: 제안이 오면 대화 끝에 칩 높이만큼 여백이 열려 끝까지 내리면 마지막 줄이 칩 위로 올라온다. 여백을 열어도 화면은 움직이지 않고, 스냅샷마다 다시 만들어지는 행도 여백으로 끌고 가지 않는다. 진짜 새 행만 여백 너머까지 따라간다. 제안이 없으면 여백도 없다(Codex 턴의 절반쯤).
- **여백은 ×를 넘어 다음 턴까지 남는다.** ×에서 닫으면 끝까지 내린 사람의 화면이 내려오기 때문이다. 그 사이 끝까지 내리면 빈 54px이 보인다. 다음 턴이 시작되면 행이 어차피 움직일 때 닫힌다. 입력창에 초안이 있어 칩이 안 보이는 경우에도 제안이 있으면 여백은 열린다.
- **`최신으로 이동`**: 칩에 가리지 않게 여백이 열린 동안 칩 위로 올린다.
- **스크롤 앵커링**: 여백을 열자 Android에서만 화면이 25–54px 움직였다. 기기에서 `scrollTop` 쓰기를 모두 기록해 JS가 아님을 확인했고, 빈 div를 붙이는 실험으로 Chromium의 CSS scroll anchoring임을 확인했다(`overflow-anchor: none`이면 0). 여백이 열린 동안만 이 스크롤 영역에서 끈다. 데스크톱 Storybook에서는 재현되지 않았으므로 기기 측정이 유일한 증거다.

측정(`mobile/e2e/wrap-up-journey.ts`, 360×800, 가짜 Codex의 예측 분기를 붙잡아 칩 없는 화면을 먼저 재고 풀어 준 뒤, 매 프레임 감시). 화면 위치는 CSS px, `움직임`은 칩이 오는 동안 프레임마다 본 최대 차이다.

| 경우 | API 35 칩 전 → 칩 → × 뒤 | 움직임 | API 29 칩 전 → 칩 → × 뒤 | 움직임 |
|---|---|---|---|---|
| 고치기 전, 꼬리에서(긴 대화) | 474.25 → 420.25 → 474.25 | 54 | 측정 안 함 | |
| 꼬리에서(긴 대화) | 474.25 → 474.25 → 474.25 | 0 | 460.33 → 460.33 → 460.33 | 0 |
| 꼬리에서(제안 작업 카드) | 401.73 → 401.73 | 0 | 387.67 → 387.67 | 0 |
| 끝까지 내린 뒤 × | 347.73 → 347.73 | 재지 않음 | 333.67 → 333.67 | 재지 않음 |
| 위로 올려 읽는 중 | 330.11 → 330.11 | 0 | 322.67 → 322.67 | 0 |

입력창 위치는 모든 경우 그대로이고(API 35 584, API 29 570), 끝까지 내리면 마지막 행 아래가 칩 위보다 24px 위다.

**승인 캡처와 다른 곳**: 칩이 초안 줄 아래가 아니라 위에 놓인다(실앱에서 초안 줄은 늘 보인다). 다른 길은 둘이었다: 입력창 바로 위에 칩을 두면 하위 대화 줄을 가리고, 캡처의 순서를 지키려고 초안 줄을 칩 위로 올리면 초안 줄이 움직인다. 이 차이는 받아들였다(2026-10-31, 조정 에이전트가 전달, [approvals.md "시안과 실캡처의 차이"](../overhaul/approvals.md)). 고정 캡처 `suggestion-phone-chip.png`와 기준 스냅샷은 바꾸지 않았다. 기준 story에는 초안 줄이 없어 스냅샷은 그대로 통과하므로, 이 차이는 시각 비교로는 잡히지 않고 기기 그림으로만 보인다. 고친 뒤 모습은 로컬 `artifacts/wrap-up-followups/final-api35/01-chip.png`.

### git이 아닌 폴더

- 데스크톱 모두 시작: git이 저장소가 아니라고 답한 폴더에서 공유 폴더 문장 뒤에 `Git 저장소가 아니라 새 워크트리를 만들 수 없습니다.`(`It is not a Git repository, so it cannot have a new worktree.`)를 잇는다. git이 답하지 않았으면 이유를 말하지 않는다.
- 폰: PC가 이미 `git-status`로 답할 수 있었다. 데스크톱과 같은 프로젝트 폴더를 물어(턴마다, 재연결마다) `ready`일 때만 `새 워크트리는 데스크톱에서…`를 보인다. `not-a-repository`, `unavailable`, 실패, 물을 길이 없음은 모두 말하지 않는다. 폰의 기존 `readNothing`은 "저장소 아님"으로 답하므로 쓰지 않았다.
- 같은 거짓이 있던 곳이 하나 더 있었다: 카드의 워크트리 권장 작업 안내(`chat-task-worktree-desktop`). 같은 규칙으로 고쳤다.
- 그래서 `useNotARepository`가 세 값(`true`, `false`, 답 없음)을 돌려주는 `useRepositoryAnswer`가 되었다.

### 펼친 거절 행

코드만 읽고 추측했던 것을 두 AI 모양(Claude는 답만, Codex는 상태 줄 + 답)과 두 스킨에서 실제로 봤다. 이유 뒤에 라벨 없는 원문이 그대로 보였고, Codex는 `…/suggest_task: failed` 줄까지 있어 영어 문장(`Stop suggesting; this one was not kept.`)이 사람에게 하는 말처럼 읽혔다. 원문은 감사 기록이라 번역·수정하지 않고 `AI에게 보낸 답`(`What the AI was told`) 아래에 둔다. 이유가 먼저인 순서와 `danger`가 아닌 색은 그대로다. 다른 도구 행은 바뀌지 않는다.

### 범위 밖에서 찾은 것, 손대지 않음

- 초안 줄이 오가면 대화 목록 높이가 약 25px 바뀐다(`mobile-v2-draft-status`, 같은 종류의 밀림이지만 대화를 열 때의 일이다).
- 칩이 온 순간 꼬리에 있던 사람에게는 맨 아래 54px이 칩에 덮인다(`모두 시작 (N)` 절반 등). 조금 내리면 보이고, 칩을 누르면 채우기만 하므로 해가 없다(사용자가 받아들인 조건).
- API 29에서 여정 끝 무렵 세 번째 새 대화의 첫 메시지가 30.4초 걸렸다(세션 생성 → 첫 턴 12초, 가짜 Codex + 소프트웨어 GPU). 여정의 기다림을 60초로 늘렸다.
- `highlighter.test.tsx`는 에뮬레이터를 켠 채 돌리면 실패했다(3번 모두, `// ok`가 주석으로 칠해지지 않음). 끈 채로는 전체 검사 2번 모두 통과했다. Shiki의 줄당 토큰화 시간 제한(500ms)으로 추정하고 확인하지는 않았다. 맞다면 느린 기기에서 첫 코드 블록의 색이 줄 끝에서 끊길 수 있다. 전체 검사는 에뮬레이터 없이 돌렸다.
- `ChatViewport`가 위로 움직였는지는 스크롤 이벤트에서 마지막 위치와 비교해 판단하는데, 커밋마다 도는 레이아웃 효과가 그 위치를 덮어쓴다. 스크롤과 그 이벤트 사이에 커밋이 끼면 움직임을 놓쳐 `최신으로 이동`이 없고 꼬리 따라가기도 켜진 채로 남는 것으로 보인다(코드와 기록을 읽은 추정이고 따로 재현하지는 않았다). `phone-findings-sheet-reference`의 기준 스냅샷이 바로 그 모습이다: 끝에서 463px 위인데 알약이 없다. 아래 플레이크에서 알약이 갈린 자리가 여기다. 글꼴을 먼저 불러오면 늘 같은 쪽으로 가서 그림은 고정됐지만 제품의 이 경합은 그대로 남아 있고, 제품 동작이라 고치지 않았다. 고치면 이 기준 스냅샷도 알약이 있는 그림으로 바뀐다.

### 시각 비교 플레이크

같은 코드에서 통과와 실패가 갈리던 기준 화면 셋: `phone-findings-sheet-reference`(1묶음), `away-claude-reference`·`recap-waiting-reference`(2묶음). 기준 커밋에서도 같았다.

| 기준 화면 | 이 브랜치 | 기준 `83cb3096` | 다른 픽셀 |
|---|---|---|---|
| `away-claude-reference`·`recap-waiting-reference` 합쳐 10번 | 4 통과, 6 실패 | 3 통과, 7 실패 | 15,486, 9,570 |
| `phone-findings-sheet-reference` 6번 | 2 통과, 4 실패 | 2 통과, 4 실패 | 330, 14,368 |

- **방법**: 실제 검사와 같은 경로(열기, axe, 스크린샷 비교)를 임시 spec으로 8–12번 돌리며 그림 찍는 순간의 페이지 상태와, 로드 중의 프레임별 변화·`scrollTop` 쓰기를 기록해 통과와 실패를 나눴다. 임시 spec은 커밋하지 않았다.
- **아닌 것**: 시계, 애니메이션, 캐럿. 데이터는 모두 고정이고 그림 찍는 시점에는 움직이는 것이 없다. 페이지가 로드 중에 둘 중 하나의 상태로 굳고 그대로 있었다.
- **원인**: `font-display: swap`. 글꼴이 첫 레이아웃 뒤에 도착하면 대화가 꼬리를 고정하는 동안 행 높이가 바뀌고(900 → 896 → 900), Chromium의 스크롤 앵커링이 앱의 쓰기 없이 위치를 옮긴다. 결과는 글꼴이 어느 프레임에 왔는지에 달렸다. ResizeObserver가 중간 높이를 보면 진짜 꼬리(끝까지 0px)로 다시 고정되고, 못 보면 2px·4px 모자란 채 남는다. 폰 시트는 같은 교체가 스크롤 이벤트의 순서를 바꿔 `최신으로 이동`이 있고 없음이 갈렸다.
- **고침**: Storybook의 전역 loader가 선언된 글꼴을 story가 올라가기 전에 모두 불러온다(`.storybook/preview.ts`). story의 첫 레이아웃이 마지막 레이아웃이 된다. 전역이라 3묶음 story도 같은 보호를 받는다. 임계값은 바꾸지 않았고 해시로 고정한 `visual/design-reference-checks.ts`도 그대로다.
- **기준 스냅샷**: 셋이 일시 상태(꼬리에서 2px·4px 모자람)를 찍고 있었다. 고친 뒤 그림은 매번 같았고, 승인 캡처와 나란히 본 뒤 그 셋만 다시 만들었다.

| 다시 만든 기준 스냅샷 | 다른 픽셀 | 새 그림 | 승인 캡처 | 옛 스냅샷 |
|---|---|---|---|---|
| `reference-2-0-turn-recap-matrix-ko.png` | 9,570 | `승인 대기 중`–도크 33px | 33px | 29px |
| `reference-2-0-wrap-up-settings-matrix-ko.png` | 14,890 | 마지막 카드–입력창 28px | 28px | 26px |
| `reference-2-0-turn-suggestion-matrix-ko.png` | 15,486 | 같은 내용이 2px 위로(승인 캡처는 대화가 짧아 꼬리 간격을 비교할 수 없다) | | |

  설정 스냅샷은 플레이크 목록에 없었다. 옛 경합이 대개 같은 쪽으로 가서 안정돼 보였고, 고친 뒤 첫 전체 실행에서 드러나 8번 모두 같은 차이로 실패했다. 설정 열은 옛 그림과 새 그림이 픽셀까지 같다. `reference-2-0-review-phone-sheet-matrix-ko.png`는 고친 뒤 상태와 이미 같아 그대로 두었고, 위 `ChatViewport` 항목의 모습을 담고 있다. 고정 캡처는 건드리지 않았다.
- **증명**: 고친 뒤 처음 셋을 합쳐 30번 반복해 30 통과. `ba396105`에서 전체 `pnpm test:visual` 10번 연속 각 96 통과, 실패 0, flaky 0(에뮬레이터 없음, 2026-10-31 21:16–22:35, 보고 `artifacts/wrap-up-followups/visual-ten/`, 로컬). 10번 모두 6006에 이미 떠 있던 Storybook 개발 서버를 재사용했다. 새로 띄운 서버에서는 돌리지 않았다.

### 후속의 최종 검사

2026-10-31, 코드 확정 `f08859b1`에서 차례로, 실패에서 멈추며 돌렸다(`artifacts/wrap-up-followups/final-*`, 로컬). 에뮬레이터는 끈 채로 시작했고 성능 측정은 돌리지 않았다.

- `pnpm typecheck`, `pnpm lint` 통과(오류 0, 경고 0).
- `pnpm test` 통과: docs:check(링크 428), Project Map check(재고정 `1a3e6710`, 주장 문구 그대로), 단위 5,236(건너뜀 5), OS 97, 가드 전부(design-reference 2.0 화면 41개 포함).
- `pnpm test:storybook` 616 통과.
- `pnpm test:visual` 이 시점에는 96개 중 95 통과, 1개 실패였다. 실패는 위 플레이크 `phone-findings-sheet-reference`이고, 그 뒤 위 절대로 고쳐 10번 연속 96 통과가 되었다. 그 수정은 Storybook 설정과 기준 스냅샷 셋만 바꾸므로 아래 기기 여정과 e2e는 다시 돌리지 않았다.
- `pnpm -C mobile typecheck`·`lint` 통과, `pnpm -C mobile test` 710 통과.
- `rm -rf .vite` 뒤 `npx playwright test e2e/turn-wrap-up.spec.ts` 13 통과.
- `pnpm --dir mobile e2e:wrap-up-journey`: `EZTerminalApi35`(WebView 124)와 `EZTerminalApi29`(WebView 74) Matrix에서 모두 통과(점검 18, 터치 대상 16개 모두 44px 이상, 그림 36장). `wm size`·`wm density`는 원래대로이고 에뮬레이터는 멈췄다.
- 돌리지 않음: 전체 `pnpm e2e`, `pnpm test:e2e:packaged`, 실제 Claude·Codex, `--old-host`와 Dark 여정, 설치판. Claude 모양의 거절 행은 녹화와 같은 모양의 story와 단위 테스트로만 봤다(가짜 Claude가 없다).
