# r4 작성자 검토·검증 기록

대상: 소프로젝트·일반 대화·편집 가능한 실행 흐름 후보. **사용자 디자인 버전 승인과 제품 구현은 미완료**입니다.
기획 수정 지시는 이 후보 작성의 근거이며 r4 화면 승인으로 기록하지 않습니다.

## 현재 확인 범위

최종 시안 검사 **245개 통과**: r4 동작/접근성 56, 공통 채팅·장면 150, 단계 연결 15,
기존 기획 연결 24. 각 보고서가 모두 `passed: true`이며 JavaScript 오류와 외부 요청은 0건입니다.
`pnpm docs:check`도 통과했습니다(활성 계약 10, 보관 문서 19, 링크 366).

검토 도구는 설치된 Playwright Chromium과 axe입니다. Windows/Android는 브라우저 viewport 모형이며 실제
Electron/provider/APK 검증이 아닙니다. 앱 내부 문구·AI 답변·실행은 예시임을 표시하고 CSP와 요청 차단을 유지합니다.

| 기록 | 범위 |
| --- | --- |
| [workflows-report.json](workflows-report.json) | r4 생성/취소·동등 목록·다중 대화·연결·AI 초안 편집/undo·실행 snapshot·분기/병렬/합류/승인/거절·보관·검증·접근성 |
| [qa-report.json](qa-report.json) | 공통 채팅/스킬/확장/입력 회귀, r4와 이전 비교 장면의 두 플랫폼 overflow·캡처 |
| [journey-report.json](journey-report.json) | 이전 r2 문서·참조·제안·실행·검토 연결 회귀 |
| [plans-report.json](plans-report.json) | 이전 r3 기획 생성·전환·대화 연결·빠른 작업·보관·수정 요청 회귀 |

보고서의 `passed`와 각 검사 결과가 실제 근거입니다. 초기 검사에서 테스트의 전송/복귀 selector를 실제
화면 경로로 바로잡았고, 실행 대화의 명령 검색을 통한 설정 변경과 보관 대화의 Enter 전송을 차단한 뒤
관련 검사를 다시 수행했습니다. 과거 r1–r3의 통과 수치를 이번 실행 수치에 합산하지 않습니다.

## 직접 비교한 화면

- [r3 시작 화면](../v2-agent-chat-r3/screens/desktop-plans-home.png)과
  [r4 시작 화면](screens/r4-desktop-home.png): 한 칸 sidebar를 유지하면서 소프로젝트와 일반 대화를
  같은 깊이에 표시했습니다. 생성 진입은 두 가지 목적이 바로 구분되게 배치했습니다.
- [r4 그래프](screens/r4-desktop-graph.png): 노드/연결, 단계 편집, 연결 검증과 실행 준비를 확인했습니다.
  초기 대각 연결이 노드 뒤를 지나는 표현을 방향이 드러나는 직각 연결과 실패 점선으로 보완했습니다.
- [Android 단계 대화](screens/r4-mobile-chat.png)와 [생성](screens/r4-mobile-new.png): 한 열 화면,
  원래 단계로 복귀, 공통 composer, 목록 기본값을 확인했습니다. 긴 생성 폼은 본문 스크롤을 사용합니다.
- [r6 D05](../v2/screens/detail/D05.png): 현재 작업과 참조 중심 위계를 비교했습니다. r4는 r3의 공통
  palette/composer 표현을 이어받았으며 r6와 픽셀 단위로 동일하다고 주장하지 않습니다. 승인된 r6나 고정
  handoff snapshot을 갱신하지 않았습니다. 테마의 정확한 runtime 값은 기존 소스가 계속 소유합니다.

캡처 전체의 사람이 수행한 정밀 검토 또는 실제 기기의 시각 승인을 주장하지 않습니다.
밝은 테마·High Contrast·Matrix, 한영·CLI, 360px 검사는 보고서의 해당 사례 범위로 제한합니다.

## 남은 제품 작업과 모형의 한계

- 소프로젝트/그래프의 영구 저장·이전·backup·암호화 복구·구버전 protocol·두 창/AI 동시 편집은 계획만 반영했습니다.
- graph inspector와 연결 폼은 동작하지만 canvas drag/zoom·좌표 저장·대규모 자동 배치는 구현하지 않았습니다.
- AI 흐름 편집은 정해진 예시 요청을 처리합니다. 자유 자연어 요청을 해석하는 실제 모델·앱 스킬·도구 연결은 없습니다.
- 실행 모형은 순차/조건/기본 병렬·모두 합류/승인/재시도와 버전 보존을 확인하는 용도입니다. 실제 도구 실행,
  조건 타입·임의 중첩 반복·부분 실패 합류·중복 event·원격 재연결·durable receipt는 제품에서 검증해야 합니다.
- 모형의 실행 기록은 메모리에 남습니다. 여러 과거 run을 고르는 전체 원장 UI, 실제 결과/패치·독립 검토/통합은
  기존 r3 비교 장면과 향후 제품 구현 경계를 따르며 r4에서 새로 구현한 것으로 보지 않습니다.
- 첫 턴 없는 실제 provider 조회, native 확장 설정 공유, 외부 Codex/Claude 앱 연결은 설치 환경에서 검증해야 합니다.
- 실제 Android Back/IME·키보드 resize·safe area·오프라인/재시작, OS 150% 배율·200% 텍스트 확대는 미검증입니다.
- 이번 작업은 계획·시안 수정입니다. 제품 빌드·설치·release 성능 벤치마크를 수행하지 않았습니다.

재현 명령은 [README](README.md), 데이터 소유권과 실행 경계는 [INTEGRATION](INTEGRATION.md)을 따릅니다.
