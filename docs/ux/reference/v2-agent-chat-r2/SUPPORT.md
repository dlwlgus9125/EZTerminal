# 근거·지원 차이·자산 출처

2026-10-13 로컬 소스·타입·CLI 도움말 및 Orca 참고 자료를 바탕으로 작성했습니다. 실제 제공자 초기화, 모델 호출, 설치, 인증, 원격 설정 쓰기를 실행한 결과는 아닙니다.

## 관찰한 현재 구현

| 근거 | 관찰 | 설계에 주는 의미 |
| --- | --- | --- |
| [agent-provider-adapter.ts](../../../../src/main/agent-provider-adapter.ts) | listModels와 세션 생성·재개·전송 경계가 있고 전체 확장 카탈로그 경계는 없음 | 기능 조회를 메시지 전송과 분리할 seam이 필요함 |
| [daemon-agent-runtime.ts](../../../../src/main/daemon-agent-runtime.ts) | idle draft 생성과 첫 turn pump의 제공자 시작이 나뉨 | 빈 대화에 provider session이 없을 때도 메타데이터를 얻는 경로가 필요함 |
| [claude-provider-adapter.ts](../../../../src/main/claude-provider-adapter.ts) | 활성 query가 없는 listModels는 기본 모델만 반환하고 활성 query에서는 supportedModels 사용 | 첫 메시지 전 모델 조회가 현재 세션 생명주기에 의존함 |
| 같은 Claude adapter의 query options | 일반 경로에서 명시적 settingSources가 없고, toolsDisabled 경로는 tools·settingSources·MCP·plugins·agents를 비움 | 일반 대화 설정 로딩을 확인하되 기획용 격리를 유지해야 함 |
| 로컬 Claude SDK `sdk.d.ts` | initializationResult, supportedCommands, supportedModels, mcpServerStatus, reloadPlugins, reinitialize, reconnectMcpServer, toggleMcpServer, setMcpServers 타입 노출 | 메타데이터/재조회 설계를 검토할 수 있음. 타입 존재가 모든 런타임 기능의 성공 증거는 아님 |

소스 리비전과 내용은 [manifest.json](manifest.json)의 SHA-256으로 기록합니다. 기존 작업 트리에 이미 진행 중인 2.0 변경이 있으므로 저장소 HEAD만으로 이 검토 기준을 표현하지 않습니다.

## 제공자별 확인 범위

로컬 환경에서 관찰한 버전은 Codex CLI `0.162.1`, Claude Code `2.1.289`, Claude Agent SDK `0.3.260`입니다. 현재 지원 모델 이름을 검증한 것은 아닙니다. 시안 모델명·추론 수준·권한 이름·설치 버전은 표시 예시이며, 제품은 실행 중인 제공자의 지원 목록으로 제한해야 합니다.

| 항목 | Codex | Claude | 남은 실제 검증 |
| --- | --- | --- | --- |
| 스킬 호출 | `$` 표기 참고 | `/` 표기 참고 | 충돌·namespace·선택 항목의 정확한 전송 방식 |
| 사전 메타데이터 | 기존 adapter/app-server 연동 검토 | SDK 초기화·조회 타입 확인 | 모델 턴 없이 실제 목록 취득, 취소·타임아웃 |
| 플러그인 | CLI help에서 add/list/marketplace/remove 확인 | CLI help에서 install/list/details/enable/disable/update/uninstall/marketplace 확인 | 버전별 관리 능력, scope와 출처 제약, Codex 활성화·업데이트 방식 |
| MCP | CLI help의 list/get/add/remove/login/logout 확인 | CLI help의 add/get/list/login/remove 등과 SDK 상태·재연결 타입 확인 | transport·인증별 상태, 갱신 적용 시점, 오류 복구 |
| 기존 설정 공유 | native 경로·명령을 통해 적용하도록 설계 | Claude Code/SDK가 읽는 설정으로 적용하도록 설계 | 설정 출처 우선순위, 프로젝트 신뢰, 다른 앱 변경과 충돌 |
| Android 원격 변경 | PC의 관리 능력을 노출 | PC의 관리 능력을 노출 | host authorization, 실패 시 원자성, 인증의 PC UI 요구 |

Claude 소비자 데스크톱 앱의 모든 확장 기능과 Claude Code/Agent SDK 기능을 동일시하지 않습니다. 화면은 일관되게 구성하되 지원하지 않는 옵션을 성공한 것처럼 표시하지 않는 것이 구현 조건입니다. 지원 차이가 있는 스킬 사용 설정·플러그인 업데이트 등은 capability에 따라 비활성화하거나 가능한 경로를 안내해야 합니다.

## Orca에서 참고한 경험

이번 조사에서 참고한 원본은 다음과 같습니다.

- [Native chat 문서](https://www.onorca.dev/docs/agents/native-chat): 구조화된 대화에서 제공자 옵션과 대화 동작을 노출하는 참고 자료.
- [installed-agent-skill-discovery](https://github.com/stablyai/orca/blob/main/src/renderer/src/hooks/installed-agent-skill-discovery.ts): 설치 스킬 탐색을 별도 조회·캐시 경계로 다루는 참고 자료.
- [native-chat-slash-commands](https://github.com/stablyai/orca/blob/main/src/shared/native-chat-slash-commands.ts): 명령·스킬 검색과 제공자별 호출 표기를 구분하는 참고 자료.
- [skill-discovery-sources](https://github.com/stablyai/orca/blob/main/src/main/skills/skill-discovery-sources.ts): 실행 환경과 출처에 맞는 탐색 참고 자료.
- [Skills CLI 문서](https://www.onorca.dev/docs/cli/skills): 설치·탐색 흐름 참고 자료.
- [OpenAI 플러그인 문서](https://developers.openai.com/plugins/build/plugins): 플러그인 구성과 출처를 별도 개념으로 다루는 참고 자료.

채택한 방향은 **첫 메시지와 기능 탐색 분리**, **설명·출처를 보여주는 통합 선택 UI**, **제공자별 실제 지원 차이 유지**입니다. Orca 코드·그래픽을 이 패키지에 복사하지 않았습니다. 외부 링크의 최신 지원 범위 전체를 이 시안의 약속으로 간주하지 않습니다.

## 자산과 실행 경계

- 아이콘: 저장소에 설치된 `lucide-react`, ISC 및 파생 Feather 아이콘의 MIT 라이선스. [Lucide 라이선스](https://github.com/lucide-icons/lucide/blob/main/LICENSE). `build.mjs`에서 인라인 SVG로 생성하며 배포 사본에 [전체 라이선스 고지](THIRD-PARTY-NOTICES.txt)를 포함합니다.
- 토큰: 저장소 `ui-tokens.css`의 생성 참조 사본. 수동 palette를 추가하지 않았습니다.
- 래스터 사진·일러스트·외부 폰트 다운로드: 사용하지 않습니다. 스크린샷은 자체 HTML 렌더 결과입니다.
- 문구·마켓·서버·파일: 직접 작성한 fixture입니다. `example.com`, 예시 Git 저장소와 PC 경로는 실제 사용 대상을 나타내지 않습니다.
- CSP `connect-src 'none'`, 외부 script 없음. 시안에서 할 수 있는 영구 쓰기는 사용자가 작성한 검토 의견의 브라우저 저장·JSON 다운로드뿐입니다.
- 새 폴더만 추가했습니다. 실제 확장 설정·자격 증명·제품 소스·기존 승인 reference를 수정하지 않습니다.
