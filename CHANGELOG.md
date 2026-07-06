# Changelog

수동 관리 (semver). 릴리스 절차: `docs/release/README.md`.

## [0.2.0] - 2026-07-06

### Added
- **설정 UI (데스크톱+모바일):** 데스크톱 우측 설정 드로어(⚙️) — 테마 직접 선택(라디오 4종)/UI 스케일
  스테퍼(80–150%, 10%씩, 기본 100%)+리셋/원격 브리지 온오프 토글+상태/앱 버전. stats·pairing과 3자
  상호배타. 모바일도 동일 구성의 전용 뷰(🎨/ThemeMenu는 parity.ts 고정좌표 의존 때문에 그대로 유지)
- **전체 UI 스케일:** 터미널+크롬 전부 rem 기반 루트 스케일로 함께 확대/축소(desktop `ui-scale.ts` /
  mobile 포트 공유). xterm은 테마 폰트 크기에 비례 리스케일 후 기존 0×0 가드 경유 리핏. 데스크톱은
  `settings.json.uiScale`, 모바일은 `localStorage`에 영속
- **원격 브리지 온오프:** `remoteEnabled` 설정(부재 시 true, 기존 `theme?` 백컴팻과 동일 패턴) — 끄면
  WS 리스너 자체가 기동하지 않고, 런타임 토글은 클라이언트 종료→포트 반환까지 직렬화돼 즉시 재시작
  가능. 비활성 시 pairing 패널에 "Settings에서 활성화" 안내
- **데스크톱 탭 스트립 오버플로:** dockview 내장 오버플로 드롭다운·탭 스트립 휠 스크롤에 4테마 스타일
  적용(이전엔 spaced 테마만 스타일돼 사실상 안 보였음) + 활성 탭 전환 시 자동 scrollIntoView
- **모바일 탭 스와이프 vs 스크롤 충돌 수정:** 스트립이 스크롤 중일 때 탭 전환 스와이프를 억제(순수
  판정 함수 `decideTabSwipe`), 활성 탭 pill 전환 시 자동 scrollIntoView

### Fixed
- dark↔matrix 테마 전환 시 xterm 폰트 크기가 13↔14로 갱신되지 않던 잠복 버그 — 테마·UI스케일 공용
  `applyTypography()` 핸들러로 교체하며 함께 수정
- 릴리스 워크플로 `release.yml`의 러너를 `windows-latest` → `windows-2022`로 고정 (ci.yml과 동일
  사유: `windows-latest`가 이제 VS18을 실어 `@electron/node-gyp`가 못 읽고 `cap` 네이티브 빌드가
  `pnpm install` 단계에서 실패하던 문제)

## [0.1.0] - 2026-07-05

### Added
- CI (GitHub Actions windows-2022): typecheck/lint/vitest/e2e/package/guard/packaged-smoke (Stage 0)
- 앱 아이덴티티: 아이콘(플레이스홀더)/저작권/win32 메타데이터 + Squirrel 인스톨러 설정 (B-M1)
- 릴리스 플로우: 태그 `v*` → 검증 → draft GitHub Release (B-M2)
- 코드서명 인프라 (env-gated, 인증서는 외부 의존) (B-M3)
- 상태 패널/패킷 캡처 의존성: `systeminformation@5.31.11`(정확 핀)·`cap@^0.2.1`; 네이티브 가드
  `guard:native-cap`; 빌드 엔트리 `vite.packet-capture.config.ts`(6번째)
- CI 러너 `windows-2022` 핀 — `windows-latest`의 VS18을 `@electron/node-gyp`가 못 읽어 `cap`
  네이티브 빌드가 `pnpm install`에서 실패하던 문제 해소 (cap은 번들 WinPcap SDK로 컴파일)

### Added (기능)
- **레이아웃 프리셋·영속 (Track A ③):** 재시작 시 레이아웃 복원, 이름 있는 프리셋
  저장/적용/삭제, 시작 프리셋 지정. 복원은 절대 이전 세션을 부활시키지 않음(전부 새 세션)
- **PTY firehose 백프레셔 (Stage C):** `!<무한출력>` 이 렌더러 큐를 무한 성장시키던 문제 —
  바이트-ack 프로토콜(xterm flush 기준 64KiB ack, 1MiB에서 pause / 256KiB에서 resume)로
  in-flight 총량이 구성적으로 유계. 실측: pause는 실제 native 배압(자식 블록)
- **빌트인 테마 (E1):** dark(기존과 동일)/light/high-contrast — 즉시 적용 + xterm 라이브
  재테마 + settings.json 영속. 헤더 버튼으로 순환
- **크래시 진단 (B-M5):** 로컬 전용 crashReporter + main.log 로테이션 + 인터프리터 크래시 배너
- **명령 팔레트 (E2):** Ctrl+Shift+P — 부분수열 필터, 탭/분할/테마/프리셋 액션, 키바인딩 중앙화
- **JS 스크립팅 (E4):** `run-script <path> [args]` — 스크립트별 격리 프로세스, `ez.run()`으로
  구조화 파이프라인 실행·가공, 배열 반환 시 표 렌더. 상한: ez.run 100k rows·출력 8MB
- **SSH 원격 (E5):** `ssh-connect user@host [--key "<path>"] [--port <n>]` — 내장 ssh2(pure-JS),
  원격 PTY 셸이 기존 xterm 블록·백프레셔 재사용. 호스트키 TOFU(변경 시 하드 실패), 비밀번호는
  세션당 프롬프트(저장 안 함), 호스트 검증이 자격증명 입력보다 항상 선행
- **크로스플랫폼 ps (E6 부분):** `ps`가 플랫폼별 소스 디스패치(win32 tasklist / posix `ps -eo`) —
  mac/linux 파서 유닛검증 완료, 실검증은 하드웨어 확보 시
- **시스템 상태 패널:** 우측 300px 비모달 오버레이 드로어 — CPU(코어 그리드)/MEM(상세·swap)/
  NET(스파크)/DISK/PROC/연결 목록. `systeminformation` 1Hz(상시 순수 JS) + 패널 개방 시 PowerShell 수집기
- **실시간 패킷 캡처:** native `cap` + Npcap — off-by-default, 1회 승인 게이트(`packetAckSeen`),
  헤더 전용, 전용 utilityProcess(`src/packet-capture/`, MessagePort 직접 브로커, rows 200 상한, rAF 병합)
- **Matrix(CRT) 테마:** 4번째 빌트인 — 녹색 인광 팔레트 + self-host woff2(Share Tech Mono/VT323,
  패키지 CSP `font-src 'self'` 대응) + `[data-theme='matrix']` 스코프 CRT 효과(스캔라인·글로우)

### Fixed
- `gen-rows 100000000` 등 고빈도 progress 스트림에서 렌더러 메인스레드 포화로
  취소 클릭이 굶주리던 문제 — progress 통지 스로틀(33ms leading+trailing)로 해소
- `setStartup`이 settings.json을 통째로 덮어써 이후 추가된 설정 필드(테마)를 지울 수 있던
  문제 — write-chain 위 read-modify-write로 교체 (E1 중 발견)

### Security
- dev 툴체인 CVE 전부 해소 → `pnpm audit` 0건: vitest 2.1→3.2.6(critical), vite 5.4→6.4.3
  (+@vitejs/plugin-react 4.7, forge plugin-vite와 호환 실증), esbuild 0.25(vite 경유),
  `pnpm.overrides`로 tar≥7.5.16·tmp≥0.2.4 (전이 의존성; tar 7은 @electron/rebuild의
  ^6 선언 위로 올린 것 — 현재 native 컴파일 경로는 prebuilds라 미사용, 향후 소스 컴파일 시 이 override 의심할 것)
- 내비게이션 가드: 모든 `file://` 허용 → 앱 렌더러 index.html 한정 (B-M6)
- Windows 패키지에서 비-Windows node-pty prebuilds·winpty 소스 제거 (~45MB 감량, 서명 가능해짐)

### Notes
- 첫 배포 트레인 `0.1.0`: Stage A(레이아웃 영속) 완료 + 원격 저장소 생성·푸시됨
  (`github.com/dlwlgus9125/EZTerminal`, private). `v0.1.0` 태그·GitHub Release 게시 완료 (2026-07-05).
