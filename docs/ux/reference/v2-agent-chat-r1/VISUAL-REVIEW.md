# r1 화면 검토·검증 기록

상태는 **검토 대기**입니다. 아래 검사는 작성자가 수행한 시안 QA이며 사용자의 디자인 확정이나 제품 출시 검증이 아닙니다.

## 검토 결과

첫 화면에서 스킬과 연결 상태가 보이고, 선택 창에서 설명·출처를 읽은 뒤 첫 메시지에 포함할 수 있습니다. 확장 관리에서는 실행 PC·제공자·범위가 목록보다 먼저 나타납니다. Android는 시트와 한 열 관리 화면을 사용합니다.

기존 r6의 [Windows 대화](../v2/screens/chat-skins/D18-ready-bubble.png), [Android 대화](../v2/screens/chat-skins/M04-ready-bubble.png)를 새 화면과 함께 열어 탐색 구조·대화 위계·입력 위치를 비교했습니다. 모바일 전역 탭은 프로젝트·대화·작업·터미널·더보기로 유지하고 확장은 설정과 더보기에서 접근하게 조정했습니다. 이번 시안 밖의 전역 기능은 범위 안내를 표시합니다.

정확한 테마 값은 현재 런타임 토큰을 사용하므로 기존 r6 참조의 graphite palette와 완전히 같은 색상은 아닙니다. 이 시안에서 독립 palette를 만들거나 런타임 토큰을 변경하지 않았습니다. 색상 일치는 제품 토큰과 r6 기준 사이의 별도 확인 지점으로 남기고, 새 대화 흐름에 대한 사용자의 시각 검토에 포함합니다.

검사 중 밝은 테마의 선택된 대화 보조 텍스트 대비 문제를 발견해 semantic text role을 조정했습니다. 또 재개 장면에서 승인 요청이 입력 영역 아래로 가려져 초기 스크롤을 최신 요청 위치로 맞췄습니다. 수정 후 선택된 밝은 테마 장면의 axe 검사와 두 기기의 승인 동작 노출 검사를 통과했습니다.

## 주요 화면

| 검토 목적 | Windows | Android |
| --- | --- | --- |
| 첫 메시지 전 준비 | [시작 화면](screens/desktop-welcome.png) | [시작 화면](screens/mobile-welcome.png) |
| 스킬 선택 | [검색 창](screens/desktop-skills.png) | [선택 시트](screens/mobile-skills.png) |
| 첫 메시지 문맥 | [초안·스킬·첨부](screens/desktop-compose.png) | [초안·스킬·첨부](screens/mobile-compose.png) |
| 질문·승인 | [밝은 테마 승인](screens/desktop-approval-light-ko.png) | [사용자 질문](screens/mobile-question.png) |
| 확장 관리 | [설치 목록](screens/desktop-installed.png) | [PC 인증 안내](screens/mobile-mcp-auth.png) |
| 복구 | [설정 충돌](screens/desktop-conflict.png) | [연결 끊김](screens/mobile-offline.png) |

## 자동 검사

재현 명령: `node docs/ux/reference/v2-agent-chat-r1/verify.mjs`.

결과의 기준은 [qa-report.json](qa-report.json)입니다. 전체 실행은 84개 검사로 구성됩니다.

- 기능 흐름 21개: 첫 턴 전 탐색, Codex/Claude 표기·설정, 문맥·커서 보존, 독립 초안, IME 합성 이벤트, 질문/승인, 대기열, 설치, 소유 플러그인, MCP, 원격 복구, 검토 의견 저장 등을 확인합니다.
- 장면 렌더·가로 넘침 50개: 25장면 × Windows/Android.
- axe 검사 9개: dark의 첫 화면·선택 창·설치 목록·모바일 질문/MCP/설치, light의 승인, high-contrast의 영어 첫 화면, matrix의 CLI 입력 장면. 이 표본에서 위반이 없다는 뜻이며 모든 상태의 접근성을 보증하지 않습니다.
- 좁은 화면 3개: 1024×720, 800×600, 360×800에서 영어·CLI 스킨과 전송 버튼 위치.
- 실행 오류·외부 요청 검사 1개: Chromium pageerror와 HTTP(S) 요청이 없는지 확인합니다.

기본 스크린샷 크기는 Windows 1440×900, Android 390×844입니다. 배율은 브라우저 기본값이며 **실제 150% UI scale·200% text zoom은 아직 확인하지 않았습니다.** 별도 PNG에 대한 pixel-diff 승인 검사는 수행하지 않았습니다. 성능 벤치마크를 실행하지 않았습니다.

## 실제 구현에서 이어질 확인

제공자 목록은 fixture이므로 실제 첫 메시지 전 metadata 조회·권한·native 설정 공유는 별도로 구현하고 검증해야 합니다. 실제 Windows 앱과 Android APK, Android 소프트 키보드와 물리 기기, 스크린리더, 사용자 글꼴·배율, 기존 설치 업데이트·대화 영구 저장도 제품 검증 대상입니다. 일반 개발 검증은 저장소 정책의 `pnpm e2e`를 따릅니다.

사용자 검토 의견은 브라우저 검토 도구에서 저장/내보낼 수 있습니다. `manifest.json`과 내보낸 의견 모두 `approved: false`이며 이 파일만으로 승격되지 않습니다.
