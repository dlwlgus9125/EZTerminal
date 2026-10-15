# r6 승인 기준 정리 검증

2026-10-13 기준 정리의 검증 기록이다. 제품 구현·실기기·출시 검증과 구분한다.

- `build.mjs`: 59개 화면·14개 기능·8개 흐름 재생성. 영속 승인 원본을 반영하고 개별 화면 상태·의견을 보존한다.
- `verify-approval.mjs`: 임시 복사본에서 승인·화면 상태·의견 보존, 두 번 재생성의 동일성, 잘못된 JSON을 덮어쓰지 않는 실패를 검사한다.
- 브라우저 승인 검사: portal 표시와 검토 JSON 가져오기/내보내기가 영속 승인을 변경하지 않는지 확인한다.
- 문서 링크와 고정 handoff guard: root 문서 검사와 reference 상대 링크, 고정 원본 보존을 검사한다.

실행 결과는 아래에 기록한다. 승인 기록 자체는 제품 구현 완료를 증명하지 않는다.

## 이전 시안 QA의 유효 범위

[qa-report.json](qa-report.json)은 승인 정리 전 r6 시안의 전체 검증이다. 이번 승인 메타데이터·
검토 포털 문구 정리로 source 해시가 달라졌다. 시안 기능의 기존 검증 근거는 보존하지만 최신
승인 포털의 전체 재검증으로 주장하지 않는다. 마지막 실행 시각과 원본 해시는 해당 report를 따른다.

## 실행 결과

2026-10-13 기준 정리 후 실행했다.

| 검사 | 실제 결과 |
| --- | --- |
| `node scripts/check-docs.mjs` | 통과: 활성 계약 10개, 아카이브 19개, 링크 360개 |
| `node scripts/guard-desktop-handoff.mjs` | 통과: surface 14개·고정 원본 19개 보존 |
| `node docs/ux/reference/v2/verify-approval.mjs` | 통과: 승인·화면 상태·의견 보존, 반복 재생성, 손상 기록 보존 |
| 실제 폴더 `build.mjs` 재실행 후 비교 | `review-log.json` 바이트 유지, 승인 manifest 바이트 유지, 321개 SHA-256 모두 일치 |
| 브라우저 Playwright 표적 검사 | 승인 표시, export/import 위조 승인 격리, 의견·화면 상태·reload 보존; overview/roadmap/handoff script error·가로 넘침 없음 |
| reference/활성 문서 상대 링크 | 1,026개 검사, 누락 0개 |
| `prototype.js`·`verify.mjs` Node 구문 검사 | 통과 |

전체 승인은 사용자 지시에서만 가져왔고 개별 화면 `reviewed` 수는 0개로 유지했다. 기존 사용자의
브라우저 화면별 기록을 읽거나 검토했다고 주장하지 않는다. 정확한 원본 해시와 승인 발화는
[최종 manifest](approvals/2026-10-13-r6-final.json)를 따른다.

첫 문서 검사에서 진행 기록을 `docs/design/`에 둔 것이 orphan으로 검출됐다. 이 폴더는 등록된
규범 계약만 허용하므로 검사 규칙을 바꾸지 않고 진행 기록을 `docs/ezterminal-v2-implementation.md`로
이동했다. 초기 manifest는 보존하고 최종 manifest에 계승 관계와 사유를 기록했다.

전체 reference QA는 이번 승인 문구 정리 뒤 다시 실행하지 않았다. 이전 r6 QA와 이번 표적 검증의
범위를 구분한다. 제품 e2e·Android 실기기·패키징·성능 측정은 이 문서 정리 작업에서 실행하지 않았다.
