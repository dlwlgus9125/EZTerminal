# 장시간 연속성 구현 기록 (Claude 데스크톱 기능 흡수 3묶음)

상태: 구현과 로컬 검수 완료. 공개 배포나 설치판 확인을 뜻하지 않는다. **실제 사용량 한도는 어느 AI에서도 본 적이 없다.**
계약: [frontend-design](../frontend-design.md) §7·§22·§23, [agent-collaboration "장시간 연속성"](../../design/agent-collaboration.md#장시간-연속성).
결정 기록: [approvals.md "장시간 연속성"](../overhaul/approvals.md#2026-11-01-장시간-연속성claude-데스크톱-기능-흡수-3묶음-실험-결정). 브랜치 `feat/long-run`. 시안·구현 판단은 사용자의 위임으로 조정 작업자가 했다: 사용자가 화면을 보고 승인한 것이 아니다.

## 요청과 범위

사용자 요청(2026-10-29 확정): 한도 리셋 후 자동 재개(중복 전달 없이), 실행 중 지시 끼워넣기. 폰은 카드·버튼까지.

- 실행 중 끼워넣기: Claude `next`, Codex `turn/steer`. 입력창 위 트레이, 들어간 자리의 행, 못 들어가면 이유를 말하는 대기열.
- 한도 카드: 자동 재개, 먼저 묻기, 재시도, 줄, 재시작 뒤 묻기, 설정 스위치 하나, 폰의 같은 카드.
- 하지 않은 것: 폰 설정, OS 알림, Claude 무인 재시도 모드(`CLAUDE_CODE_RETRY_WATCHDOG`), `thread/queue/*`, 자식의 자동 재개.

## 구현

- **공용 모델** `src/shared/long-run.ts`(글, 시각, 상한, 단계), 대화 기록 payload 넷(`usage-limit`, `steer`, `app-sent`, `steer-queued`), DB 마이그레이션 없음.
- **호스트**: `src/main/long-run-coordinator.ts`, `src/main/long-run-timing.ts`(`app.isPackaged`면 시각 단축을 무시), 어댑터의 한도 경로·`recoverLimit`·`steer`, 명령 `agent.steer`·`agent.steer-settle`·`long-run.limit-action`, 파일 `long-run-jobs.json`·`long-run.json`, 버전 하한.
- **화면**: `src/renderer/chat/long-run/`(`SteerTray`, `AppSentRow`, 표시 판단), `src/renderer/long-run-commands.ts`, `LongRunSettings`, 목록과 피드. 폰은 같은 host·카드를 쓰고 설정은 없다.
- **곁에서 고친 것**: 도는 턴 없이 온 복구 가능한 오류가 대화를 실패로 만들던 것, 폰 보안 저장소의 `agent.steer` 거절, 보낸 메시지 아래 남던 입력창의 필수 항목 줄, 일반 전송의 수정 번호 경쟁, Android 10 WebView의 긴 단어·아이콘 정렬(`chat.css`만).

## 검수

- 시안: Storybook `Production/LongRun/Mockup`, Codex gpt-6-astra max 1회와 고침 범위 재검수 1회(반드시 고침 6건, 권장 1건 반영).
- e2e: `e2e/long-run.spec.ts` 24개(가짜 Codex, 실제 앱). 가짜 Claude는 없어 Claude는 재생 테스트와 아래 실행에 기댄다.
- 재생: 실제 CLI를 가짜 서버에 붙여 녹화한 응답(`src/main/test-fixtures/long-run-replay.test.ts`).

### 스텁 실행 (실제 앱·실제 CLI + 가짜 서버)

`scripts/verify-ux-live.mjs --stub`, Claude CLI 2.1.312, Codex 0.165.0, 보고 `artifacts/long-run/live/final-*`(로컬). 실제 앱과 실제 CLI를 127.0.0.1 가짜 서버에 붙였고 다른 것은 프록시가 막았다.

- 마지막 실행에서 55개 시나리오가 끝났다(Claude 26, Codex 29). `final-stub`의 판정은 `ok=false`다: `codex-steer-refused-review`는 기대한 `-32600`을 하네스가 실패로 세었고 `codex-steer-refused-stale`은 하네스의 `agent.create`가 수정 번호 경쟁에 졌다. 두 시나리오를 따로 돌린 `final-refusals`는 통과했다(`final-stale` 단독 실행은 같은 `-32600` 집계로 `ok=false`).
- 가짜 서버가 본 요청은 모두 더미 인증이다(`credentialAudit`: Claude 188건·Codex 135건, 진짜 인증 0).
- 시간은 실제 값으로 쟀다. 재시도 간격 600,222ms(Claude)·600,282ms(Codex), 줄 간격 60,734ms·60,749ms.
- 여기서 찾아 고친 것: 줄의 둘째 대화가 첫 대화의 시각을 보임(`bd8816a5`), 관리 자식의 `이어서 하기`(`c1ecd6d2`, 경로를 이 실행으로 확인한 뒤 `MANAGED_RESUME_PROVEN`을 켰다).

### 실제 AI 끼워넣기 (한도 없음)

보고 `artifacts/long-run/live/real-1`~`real-4`(로컬). 16회: Claude 9, Codex 7. Codex 1회는 하네스의 스크린샷 경합이라 다시 돌렸다.

| AI | 경우 | 들어가기까지 | 캐시 비율 |
|---|---|---|---|
| Codex | 도구 옆·글 쓰는 중 | 887–973ms | 0.994–1.002 |
| Codex | 승인 뒤 | 3.9–4.1초(답한 뒤) | 0.997–0.998 |
| Claude | 도구 옆 | 18.9–21.8초 | 1.000 |
| Claude | 글 쓰는 중 | 8.6–10.4초(새 턴) | 0.999–1.000 |
| Claude | 승인 뒤 | 5.8–5.9초 | 1.000 |

모델의 행동은 Claude 9회 중 8회, Codex 6회 모두 지시를 따랐다. Claude 1회는 들어갔지만 따르지 않았다(Haiku, 시험용 표식 문구). 같은 뜻을 평범한 말로 쓴 3회는 모두 따랐다. 그래서 `실행 중에 끼워넣음`은 도착만 뜻한다.

### Android

`mobile/e2e/long-run-journey.ts`, 가짜 Codex 격리 데스크톱, 360×800, 한국어. 20단계 소스에서 API 35 Matrix, API 29(WebView 74) Matrix와 Dark, 기능 이전 PC에 붙은 경우를 두 API에서 통과했다. 최종 소스의 APK로 API 35 Matrix를 다시 돌려 통과했다(`artifacts/long-run/capture-real/phone-api35/`, 점검 14, 터치 대상 13개 모두 44px 이상, 그림 34장). 최종 소스로 API 29와 기능 이전 PC는 다시 돌리지 않았다.

폰에서 찾아 고친 것(모두 실패 테스트부터): 폰 보안 저장소가 `agent.steer`를 대기 명령으로 받지 않아 **실행 중 보내기가 어느 기기에서도 동작하지 않았고** 모의 객체가 이것을 가렸다, 보낸 메시지 아래 답이 올 때까지 필수 항목 줄이 남음, 일반 전송에 수정 번호 경쟁 재시도가 없음, WebView 74의 `anywhere`, 전송·중지 아이콘 어긋남, 접힌 트레이 제목 줄바꿈.

### 최종 수정

`그대로 두기`와 `직접 보낸 메시지도 거절됨`의 머리글이 `준비됨`이었다(시안은 `한도로 멈춤`). 스냅샷이 그 카드를 놓아 주어 머리글과 목록이 에이전트 상태로 돌아갔기 때문이다. 이제 스냅샷이 끝나지 않은 멈춤을 싣되, 대화에 다른 턴이 돌면 싣지 않는다. 그 작업은 지우지 않아 카드의 `이어서 하기`가 남는다. 단위·e2e·폰 여정에 실패 테스트를 먼저 넣었다(e2e는 수정 전 `Status: Ready`로 실패). 목록도 같은 값을 읽어 함께 바뀐다.

## 계획과 달라진 것

- 줄: 모든 AI에 하나 → AI마다 하나.
- `not-included`: 끝난 것 → 놓였지만 말하는 것(버튼 없음, 다른 턴이 닫음).
- 맨 429: "또는 상태 429"로 잡지 않는다. 실제 기록을 따랐다.
- 끼워넣기 기록과 재개 세기를 `{jobs, steers, autoResumes}` 한 파일에 둔다.
- 멈춘 대화에 낡은 창이 보낸 `agent.steer`는 대기열 이유 `limit-open`으로 간다.
- 관리 자식의 `이어서 하기`는 켰다. 시안의 `provider` 자식 카드는 없앴다. 그런 자식은 카드가 없다.
- 추가: 자동 이어가기 상한 3, `steer-unconfirmed`, 30초가 지나면 들어가지 않은 끼워넣기가 대기열을 붙잡지 않음.

## 재지 못한 것

- **실제 한도.** 어느 AI에서도 겪어 보지 않았다. 한도의 모양, 글, 리셋 시각은 모두 실제 CLI가 가짜 서버의 응답을 받아 낸 모양과 Claude의 실제 기록 비교에 기댄다. Codex의 실제 한도 기록은 0건이다.
- 실제 모델이 "Continue." 뒤에 무엇을 하는지, 긴 대기 뒤의 캐시, 이른 재시도의 서버 쪽 비용, 실제 Claude 429의 `x-should-retry`, 실제 Codex 429의 본문.
- 앱을 통한 Codex 압축 거절, 실제 모델에서의 끊고 보내기, 재시작 뒤 끼워넣기 복구(e2e는 물을 때까지만), 잠자기와 깨어나기, `skipped`(계획 제안에서만 생긴다), `recoverLimit`이 리셋을 돌려주는 경우, Claude `cancelled` without `started`.
- 폰에서 돌리지 않은 것: 관리 자식의 카드, `skipped`, 재시작 뒤 끼워넣기 복구, Claude(가짜가 없다).
- 패키지 EXE에서 장시간 연속성 경로를 돌리지 않았다. `pnpm test:e2e:packaged`는 이 경로를 지나지 않는다.
- 성능 측정은 돌리지 않았다. 설치 파일은 만들지 않았다.

## 남은 것과 범위 밖에서 찾은 것

- 범위 밖, 손대지 않음: `codexReviewForkRequest`, 턴 도는 중 Codex `/btw`, 다른 스타일시트의 옛 `overflow-wrap: anywhere` 약 110곳, `agent-management:45`·`project-workbench:379` 플레이크.
- `src/shared/automatic-calls.ts`는 사람이 누르지 않아도 나가는 호출을 모두 적는다고 말하지만 자동 재개는 등록돼 있지 않다. 자동 재개에는 별도 스위치와 규칙이 있어 지금 동작에는 영향이 없다.
- 폰의 입력창에서 사용량 막대 셋이 있으면 자기 줄로 내려가 입력창이 한 줄 높아진다(시안에는 없음, `limit-phone-card`).
- 시안 승인 뒤 생긴 글은 사용자가 본 적이 없다([목록](../overhaul/approvals.md#장시간-연속성-구현-중-정한-것-조정-작업자의-위임-판단-사용자의-결정이-아니다)).
