# 시각 검토 기록

대상: `0.1-review` r6 기획·설계. 아래는 작성자 검토 이력이며 2026-10-13 사용자 전체 진행 지시로 [설계 기준을 승인](APPROVAL.md)했다. 개별 화면 클릭 검토나 실제 제품 화면의 QA 결과를 주장하지 않는다.

현재 시각 revision은 r6다. r3·r4·r5 기록은 이전 검토 이력이며 최신 검증은 문서 끝의 r6 절을 따른다. r3에서는 기획 이후 단계와 역할별 설정을 12개 기존 화면에 반영했다. r2에서는 사용자 피드백을 반영해 상단 영역 전환과 왼쪽 단일 목록으로 정리했다. 대화·검토·파일의 수정 전후, 대화의 상세·wireframe, 산출물 펼침과 좁은 화면 서랍을 비교했다. [탐색 깊이 개선 기록](NAVIGATION-REVIEW.md)에 결정과 전후 이미지를 연결했다.

## 확인 범위와 결과

| 검토 | 확인한 내용 | 결과·근거 |
| --- | --- | --- |
| 기획 화면 | 대화·문서 위계, 입력창과 문서 스크롤 분리, wireframe과 상세 시안의 동일 구조 | [D05 상세](screens/detail/D05.png), [wireframe](screens/wireframe/D05.png) |
| 화면 편집 | 요소 목록·선택 영역·속성·수정 요청의 위치 | [D10 상세](screens/detail/D10.png), [wireframe](screens/wireframe/D10.png) |
| 작업 진행 | 대표 AI와 배정 현황, 작업·검토 상태의 일치 | [D16](screens/detail/D16.png) |
| 검토 센터 | 기준·결과 패널, 수용 조건과 의견 입력 | [D20](screens/detail/D20.png) |
| Android 기획 | 한 화면의 선택 요소와 터치용 속성 편집 | [M06 상세](screens/detail/M06.png), [wireframe](screens/wireframe/M06.png) |
| 대화 스킨 | 같은 내용과 입력 대상을 말풍선·터미널형으로 표현 | [Windows 터미널형](screens/variants/D18-terminal-skin.png), [Android 터미널형](screens/variants/M04-terminal-skin.png), [말풍선](screens/detail/M04.png) |
| 테마 | 문서 위계와 주요 행동의 구분 | [Light](screens/variants/D05-light.png), [Matrix](screens/variants/D18-matrix.png), [High Contrast](screens/variants/D20-contrast.png) |
| 예외 상태 | 확정 대기와 연결 끊김의 원인·복귀 행동 | [D13 판단 대기](screens/variants/D13-blocked.png), [M16 오프라인](screens/variants/M16-offline.png) |
| 좁은 창 | 문서·대화 전환 버튼과 화면 잘림 | [D05 800×600](screens/variants/D05-800x600.png), [D11 800×600](screens/variants/D11-800x600.png) |
| PC 제어 | 시작 전 상태, 명시적 시작, 설정 진입 | [M11](screens/detail/M11.png) |
| 검토 페이지 | 첫 화면 미리보기와 시안·명세·의견 패널 | [패키지 개요](screens/variants/review-overview.png), [D05 검토](screens/variants/review-D05.png) |
| 흐름별 예상 화면 | 8개 흐름 선택, 46단계의 행동·화면·변화·다음 조건, 8개 복구 장면 | [흐름 선택](screens/flows/review-flows.png), [기획 단계와 화면](screens/flows/U01-step03.png) |
| 예상 화면 확대 | 확대 상태에서 단계 이동, 작은 화면에서 이미지와 닫기·이전·다음 유지 | [Android 흐름 확대](screens/flows/U04-mobile-preview.png) |
| AI 운영 설계 | 8개 역할의 설정·프롬프트 병치, 4개 운영 방식, 단계별 AI 적용 구분 | [설계 페이지](screens/flows/ai-operating.png), [390px 역할 보기](screens/flows/ai-profile-390x844.png) |

표의 대표 화면은 이미지를 직접 확인했다. 전체 59개 화면은 브라우저 렌더링·overflow·제목·참조를 기계 검증했으며, 모든 화면의 상세와 wireframe 이미지를 생성했다. 대표 화면 검토를 사용자의 전체 화면 검토로 확대 해석하지 않는다.

## 발견 후 반영한 수정

1. D16에 기획 단계의 문구가 남아 있어 작업 진행 상태와 대표 AI의 배정 설명으로 교체했다.
2. D20의 비교 그림이 패널 아래로 넘치는 문제를 수정하고 경계 안에 들어오는지 확인했다.
3. 좁은 D05의 비활성 안내 표식을 실제 전환 버튼으로 교체했다. 탭·스킨을 바꿀 때 작성 중 입력을 유지한다.
4. 검토 페이지 캡처 시 화면 이동과 이미지 decode가 끝나기 전에 촬영하던 문제를 수정했다. 59개 미리보기의 로드를 모두 확인했다.
5. Desktop·Android 요소 편집 체험에서 사용자가 입력한 안내 문구가 시안에 반영되도록 했다.

## 자동 검증

최종 상세 결과: [qa-report.json](qa-report.json). 참조 파일 hash와 이미지 목록: [manifest.json](manifest.json).

- 59개 화면: 상세 59장 + wireframe 59장.
- 정상 외 상태 102개: 화면별 문구와 복귀 안내 확인.
- 반응형 30개 조건: 본문 가로 overflow 없음. 흐름 페이지의 390px·800px, 확대 창의 버튼 노출, AI 운영 페이지의 390px·1440px를 포함.
- 흐름별 예상도: 8개 흐름 × 상세·wireframe 2종, 정상 46단계 + 복구 8장면의 이미지 로드·대응 화면 확인.
- 상호작용 24개 묶음: 단일 탐색, 세션별 입력 복원, 산출물 전환, 서랍·focus 복귀, 편집·되돌리기, 설계 확정과 실행 분리, Android 입력, 검토 JSON 왕복과 revision 간 의견 보존, 흐름 단계 링크·새로고침·뒤로 가기·확대·방향키·복귀, 역할별 프롬프트·흐름 연결 및 조회 중 설정 불변 등.
- 접근성 자동 검사 21개 대표 화면·상태: WCAG 2 A/AA·2.1 AA 관련 axe 위반 0건. 흐름 페이지·확대 창·AI 운영·기획 이후 단계·모바일 역할 설정과 실행 준비·작업·후보·통합 화면 포함. AI 운영 페이지의 본문 링크가 색상 외에도 구분되도록 밑줄을 추가한 뒤 재검증했다.
- 외부 요청 0건, 브라우저 스크립트 오류 0건, 보고된 검증 문제 0건.

`node scripts/check-docs.mjs`와 `node scripts/guard-desktop-handoff.mjs`도 통과했다. 기존 활성 계약과 고정 v1 handoff의 소유권을 유지했다.

## 남은 검토

사용자는 [검토 화면](index.html)에서 전체 범위와 시안을 확인하고 의견을 남긴다. 브라우저 prototype의 결과가 실제 Electron·Android 기기에서의 입력·접근성·렌더링 검증을 대체하지 않는다. 해당 검증은 설계 확정 후 제품 구현 단계의 완료 조건이다.

고정 v1 snapshot은 갱신하지 않았다. 이번 캡처는 별도 v2 후보 자료이며 P6–P7을 완료 처리하지 않았다.

r3은 변경된 12개 화면만 재검토 대상으로 전환한다. r1→r2의 Desktop 변경 이력도 화면별 revision으로 유지하며 기존 의견과 바뀌지 않은 화면의 검토 표시는 보존한다. 정상 화면의 예시 데이터는 단계별 실행 결과로 간주하지 않으며, 같은 화면을 재방문하는 목적은 장면별 설명으로 구분했다.

AI 운영 보강안도 기획 자료다. 실제 프로필·모델 연결·지시문 실행은 수행하지 않았다. 설정 폼과 실패·복구 화면은 r3 시안에 반영했으며 사용자 확인은 남아 있다.

## r3 기획 이후 단계의 작성자 검토

D15의 [r2](screens/previous/D15-detail-r2.png)와 [r3](screens/previous/D15-detail-r3.png)를 비교했다. 팀 방식과 진행 정책을 구분하고 Windows·Android 구현 담당을 각각 설정하는 진입을 배치했다. D36 역할 설정, D16 대표 대화와 작업 보드, D24 출시 준비·실패 복구, Android 모델 설정 sheet, 390px 기획 이후 안내를 이미지로 확인했다.

기존 탐색 한 칸을 유지하며 별도 제품 로드맵 메뉴를 만들지 않았다. D24 내부의 출시 준비·충돌 복구는 검토 목적의 하위 보기다. 검토 포털의 기획 이후 단계는 7단계를 화면과 함께 제시한다. 이전 시안은 screens/previous에 보존했으며 고정 v1 자료는 변경하지 않았다.

추가 확인: W01–W09 상세 인계의 입력·출력·인터페이스·검증·실패 복귀, 7단계의 화면·역할 참조와 로컬 문서 링크 731개를 검사했다. 상단 동작과 본문 동작을 같은 시뮬레이션에 연결했으며 후보 비교를 시작하면 비교 화면으로 이동한다.


## r4 확정 정책과 화면의 작성자 검토

2026-10-13 당시 r4 기록: 11개 정책 확정 이후 기획·예상 화면·구현 인계를 보완했으며 전체 화면·P7·제품 구현 승인은 후속 단계였다. 이후 같은 날 r6 설계와 구현 진행이 전체 지시로 승인되었다([현재 승인 근거](APPROVAL.md)). 이 이력은 개별 화면 클릭 검토나 제품 구현 완료를 주장하지 않는다.

- D36의 [r3](screens/previous/D36-detail-r3.png)와 [r4](screens/detail/D36.png)를 비교했다. 모델 선택뿐 아니라 지시문·문맥·도구 직접 편집, 저장·AI 수정 제안·편집 취소·버전 이력 동작을 배치했다. 주요 동작을 편집 영역 상단으로 옮겨 긴 지시문에서도 찾을 수 있게 했다.
- [변경 영향](screens/policies/replan-impact.png)에서 영향 작업·후속 의존 작업·계속 진행하는 작업을 구분했다. [AI 수정 비교](screens/policies/profile-proposal.png)에서는 변경 전후와 이유 및 적용·취소를 같은 장면에서 확인했다.
- [Android 오프라인](screens/policies/offline-draft.png)의 상단 연결 표시와 본문 상태를 일치시켰다. 초안·마지막 동기화·재연결 후 직접 전송을 구분한다.
- [Desktop 정책 흐름](screens/policies/portal-1440.png)과 [좁은 화면](screens/policies/portal-390.png)을 검토했다. 8개 흐름·18개 장면의 설명과 상세 시안/와이어프레임을 연결했다.
- 기존 U03에 실행 전 카드와 실행 후 상태를 나누고, U08에 영향 작업·변경 계획 검토를 추가했다. 전체 8개 흐름은 48단계다.

당시 검사 결과는 [r4 qa-report](screens/previous/qa-report-r4.json), 재현 명령은 `node docs/ux/reference/v2/verify.mjs`다.

화면 59개, 상태 107개, 반응형 40개, 상호작용 32개, 접근성 31개, 발견 문제 0개. 18개 정책 장면은 상세·wireframe 두 표현으로 캡처했다. 브라우저 오류·외부 요청은 없으며 모든 저장 동작은 검토 탭의 예시 상태만 사용한다.

이 검사는 설계 참고자료의 탐색·상태 표현·상호작용을 확인한다. 실제 provider 전환, 지속 저장, PC 프로세스 격리, 백업 이동, Android 강제종료 복구의 제품 검증은 W01–W09 수용 기준으로 남아 있다. 앱 e2e와 성능 측정을 실행하거나 통과했다고 주장하지 않는다.

## 산출물 권위와 도구 범위

- 기존 [루트 DESIGN.md](../../../../DESIGN.md)와 [활성 UX 계약](../../frontend-design.md)은 그대로 유지한다. v2의 [DESIGN-PROPOSAL.md](DESIGN-PROPOSAL.md), [SCREENS.md](SCREENS.md), [정책 동작 설계](POLICY-CONTRACTS.md)가 검토용 설계 맥락이다.
- 시각 방향은 기존 v2의 차분한 Dark·말풍선을 유지하고 두 대화 스킨·Matrix 선택을 보존한다. 정확한 제안값은 prototype.css에만 둔다. 새 브랜드·토큰 source나 production mapping을 추가하지 않는다.
- frontend-design 스킬의 google-alpha-0.4.0-ezpowers-1 profile은 참고 지침으로 읽었다. 저장소에는 해당 managed mapping·.ezpowers/tools가 없고, 이번 작업은 활성 DESIGN.md 마이그레이션이 아니므로 profile 채택·lint 통과를 주장하지 않는다. 저장소 AGENTS.md의 문서 소유권을 우선한다.
- 설치된 프로젝트 Playwright·Chromium·axe로 참고 화면을 검사했다. `scripts/check-docs.mjs`의 활성 계약·링크 검사와 `scripts/guard-desktop-handoff.mjs`의 고정 원본 검사를 통과했다. 기존 제품 변경 diff는 작업 시작 시점과 동일하다.


## r5 터미널형 구조 재검토

2026-10-13. 사용자 피드백은 “터미널형이 아니라 말풍선형으로 보인다”였다. r4의 우측 사용자 정렬·가운데 최대폭·산출물 카드·큰 하단 입력창이 터미널형에도 남아 있었다. 터미널형을 좌측 연속 출력, 산출물 행, 출력 바로 뒤 프롬프트로 재구성했다. 제품 UI 코드는 변경하지 않았다.

| 검토 대상 | 이전 시안 | 수정 시안 |
| --- | --- | --- |
| Windows | [r4](screens/previous/D18-terminal-skin-r4.png) | [r5](screens/previous/D18-terminal-skin-r5.png) |
| Android | [r4](screens/previous/M04-terminal-skin-r4.png) | [r5](screens/previous/M04-terminal-skin-r5.png) |

두 플랫폼의 전후 캡처와 PC 상세·와이어프레임을 직접 비교했다. 사용자 메시지의 우측 정렬 잔여 스타일을 제거하고 모바일 상단의 중복 역할 정보를 줄여 입력줄 접근성을 확보했다. [두 스킨 나란히 보기](index.html#design)는 같은 대화 내용을 사용하며 PC·Android 체험 링크를 제공한다.

검증: `node docs/ux/reference/v2/verify.mjs`. [r5 qa-report](screens/previous/qa-report-r5.json)에 화면 59개·상태 107개·반응형 48개·상호작용 35개·접근성 36개, 문제 0개를 기록했다. 터미널형 전용 검사는 두 스킨의 메시지·초안 보존, 좌측 출력과 프롬프트 구조, 작은 화면에서 입력 접근, 산출물 열기, IME 조합 중 전송 방지, Android 명시적 전송과 네 테마의 axe 검사다. 비교 페이지도 1440·390 폭에서 가로 넘침과 axe 위반이 없었다.

검토용 캡처는 장면마다 새 문서를 열어 이전 전환 알림·초안이 섞이지 않게 했다. 실제 provider·PTY·Android 키보드·스트리밍·읽기 위치 복원 및 모든 승인/도구 세부 상태는 향후 제품 구현 검증 대상이다. 기존 활성 DESIGN/UX 계약과 고정 handoff는 유지한다. 사용자 전체 설계 확정과 제품 구현 승인은 여전히 대기 중이다.

## r6 채팅 기반 CLI 스킨 상세 시안

2026-10-13. 사용자 요구를 “실제 동작은 메시지 단위 채팅, 외형만 CLI”로 명확히 반영했다. 좌측 출력 흐름과 간결한 프롬프트는 유지하고 두 스킨이 같은 메시지·첨부·답장·승인·입력 상태를 사용한다. r5의 별도 시작 배너와 출력 안 프롬프트는 제거하고, 두 스킨 모두 하단 고정 채팅 입력을 사용한다. [상세 계약](CHAT-SKINS.md)이 동작을 소유한다.

[상태별 비교 화면](index.html#chat-skins)은 Windows/Android × 대화 완료·첨부와 답장·응답 중·승인 대기·결과 검토 × 두 스킨의 상세 시안 20장과 CLI 와이어프레임 10장을 제공한다. Windows의 결과 검토는 옆 패널, Android는 문서 화면으로 이동하는 흐름이다.

| 직접 검토한 대표 장면 | 확인 내용 |
| --- | --- |
| [Windows 첨부·답장](screens/chat-skins/D18-compose-terminal.png) | 좌측 발화자와 메시지 동작, 답장 인용, 첨부 미리보기, 입력·AI 설정·전송의 구분 |
| [Android 첨부·답장](screens/chat-skins/M04-compose-terminal.png) | 좁은 화면에서 첨부와 입력이 겹치지 않고, 대화 기록과 하단 입력이 별도로 배치됨 |
| [Windows 승인 대기](screens/chat-skins/D18-approval-terminal.png) | 대상·이유·거절·허용을 같은 위치에서 확인 가능 |
| [Windows 결과 검토](screens/chat-skins/D18-review-terminal.png) | 대화와 연결 문서를 나란히 보고 입력을 계속 사용할 수 있음 |
| [스킨 비교 화면](screens/chat-skins/portal-1440.png) | 같은 장면의 말풍선·CLI 시안과 플랫폼·장면 전환을 함께 제공 |

첨부 버튼에 삭제 버튼의 좁은 폭이 적용되던 스타일과 CLI 사용자 이름의 우측 정렬 잔여 스타일을 수정한 뒤 이미지를 다시 확인했다. 최종 PC·Android 첨부 장면과 PC 결과 검토 장면도 재생성된 이미지로 확인했다. 기존 고정 desktop handoff 및 제품 코드는 변경하지 않았다.

검증: `node docs/ux/reference/v2/verify.mjs`. 승인 정리 전 [qa-report.json](qa-report.json)은 화면 59개·상태 127개·반응형 48개·상호작용 38개·접근성 58개, 문제 0개다. 두 스킨 전환 전후 메시지 ID·내용·초안 선택 범위·첨부·답장 보존, 예시 전송, 응답 중 대기열, 승인 거절 상태 보존을 확인했다. CLI 입력이 대화 스크롤 밖에 있고 화면 안에 남는지, IME 조합 중 전송 방지와 모바일 명시적 전송, 대표 테마 및 비교 화면의 axe 검사도 포함한다.

이 검증은 브라우저에서 동작하는 검토용 예시의 범위다. 실제 업로드·AI 연결·스트리밍·파일 내보내기·앱 재시작·Android 소프트 키보드·보조 기술은 제품 구현 단계에서 검증한다. 이 시안 검증 당시 사용자 전체 검토와 P7 승인은 대기였고 제품 구현을 시작하지 않았다. 이후 승인 상태는 아래 기록을 따른다.

## r6 전체 승인 기준 정리

2026-10-13 사용자 전체 진행 지시로 [P6/P7 승인 기준](APPROVAL.md)을 기록했다. 활성 DESIGN/UX에 r6 계약을 승격하고 generator·검토 포털의 승인 상태 문구를 정리했다. 위 r6 시안 QA 이후 `content.mjs`, `prototype.js`, 생성 데이터와 관련 원본 해시가 달라졌으므로 기존 보고서를 최신 포털 전체 재검증으로 주장하지 않는다. 화면 이미지와 이전 QA를 보존하고 [이번 변경의 표적 검증](APPROVAL-VALIDATION.md)을 별도로 기록한다. 개별 사용자 화면 클릭이나 제품 검증 완료를 생성하지 않았다.
