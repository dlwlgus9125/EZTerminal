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
