# Changelog

수동 관리 (semver). 릴리스 절차: `docs/release/README.md`.

## [0.8.1] - 2026-07-11

모바일 소프트키보드 IME 입력 증식 버그 수정.

### Fixed
- **모바일 타이핑 시 이전 입력 증식 (Z Fold 7 + 삼성키보드):** xterm의 숨김 helper
  textarea가 Enter/blur 외엔 비워지지 않아 안드로이드 IME(keyCode 229) 커밋이 무한 누적됐고,
  키보드 자동교정/예측이 기커밋 텍스트를 고쳐 쓰는 순간 xterm CompositionHelper의
  String.replace 기반 diff가 실패해 **누적 버퍼 전체가 PTY로 재전송**됨 — 붙여넣은 이전
  대화가 타이핑마다 증식. 이제 커밋마다 textarea를 비워(조합 중엔 유예 — 한글 조합 보호)
  키보드가 재작성할 stale 컨텍스트 자체를 제거 (`src/renderer/xterm-ime-hygiene.ts`)
- **모바일 컴포저 비조합 커밋 유실:** 추천 단어 탭/단어를 커밋하는 스페이스/키보드 클립보드
  붙여넣기가 plain-PTY 실행 중 PTY로 라우팅되지 않고 입력창에 쌓이던 갭 — `beforeinput`
  라우팅(`mobile/src/composer-input.ts`)으로 해소, 데스크톱에만 있던 컴포저 onPaste 패리티 추가
- **롱프레스 Paste 브래킷 프레이밍:** xterm 블록(claude/codex)에 붙여넣을 때 raw 바이트 대신
  `term.paste()` 경유(BlockController paste seam) — bracketed-paste 프레이밍 + 개행 정규화로
  여러 줄 붙여넣기가 줄마다 제출되지 않음

### Notes
- 회귀 가드: 삼성키보드형 IME 이벤트 시퀀스를 합성해 실제 xterm 리스너를 구동하는 e2e 4종
  (`e2e/ime-input.spec.ts` + `fixtures/ime-echo.js`)과 유닛 14종 추가 — 새 베이스라인
  unit 772 / mobile 117 / e2e 115

## [0.8.0] - 2026-07-10

Public 전환 전 보안 리뷰 하드닝 — 원격 제어 WS 브리지 attack surface 축소.

### Security
- **원격 제어 기본 OFF (opt-in):** 브리지는 페어링된 기기에 호스트의 임의 명령 실행 + 파일
  전체 접근을 부여하므로, 이제 사용자가 Settings에서 명시적으로 켜기 전까지 리스너를 열지
  않음(기존: 기본 ON). 갓 설치한 앱은 원격 표면을 전혀 노출하지 않음
- **Origin 검증 (CSWSH / DNS-rebinding 방어):** WS 서버가 브라우저 cross-origin 연결을 거부 —
  Capacitor WebView origin(`http://localhost`)과 non-browser 클라이언트만 허용
- **상수시간 토큰 비교:** 페어링 토큰 비교를 `===`에서 `crypto.timingSafeEqual`(길이 선검사)로 교체
- **pre-auth DoS 가드:** 인바운드 프레임 크기 상한(1 MiB), 동시 연결 수 상한(64), 인증 데드라인
  (10초 내 미인증 소켓 종료)
- **모바일 토큰 at-rest:** `android:allowBackup="false"` — 장기 자격증명이 `adb backup`/자동
  백업으로 유출되지 않도록
- **`.gitignore` 위생:** 루트에 `*.exe`/`*.apk`/키스토어(`*.jks` 등)/`*.backup.*` 무시 규칙 추가 +
  Android 키스토어 무시 활성화 — 서명 자료·설치파일 실수 커밋 방지
- **문서:** `SECURITY.md` 추가 — 원격 브리지 trust-model(페어링 = 전 디스크 접근, 평문 `ws://`는
  신뢰 네트워크/Tailscale 전제)

### Notes
- 전송 암호화(`wss://` + 인증서 pinning)는 후속 과제 — 현재는 Tailscale/WireGuard 오버레이의
  암호화에 의존

## [0.7.0] - 2026-07-10

Windows Terminal 동작 파리티 (M0–M5).

### Fixed
- **Ctrl+C가 서브에이전트 트리 전체를 종료하던 문제 (M0):** `claude`/`codex` 같은 npm `.cmd`
  shim은 `cmd.exe /d /s /c "shim.cmd"`로 래핑돼 ConPTY 콘솔 프로세스 그룹에 cmd.exe가 끼었고,
  Ctrl+C(`\x03`)가 그룹 전체 CTRL_C_EVENT로 변환되며 에이전트와 그 하위 프로세스까지 함께 종료됨.
  이제 `.cmd`/`.bat` shim을 실제 대상(`node <cli>` 또는 `<target>.exe`)으로 de-sugar해 cmd.exe
  없이 직접 spawn — 에이전트가 콘솔 리더가 되어 Ctrl+C가 트리를 죽이지 않음. 인식 못한 shim은
  기존 cmd.exe 경로로 안전하게 폴백(회귀 없음)

### Added
- **터미널 안전 애플리케이션 메뉴 (M1):** Electron 기본 메뉴가 상주시키던 위험한 액셀러레이터를
  제거 — `Ctrl+R`(앱 리로드)·`Ctrl+Shift+R`·`Ctrl+W`(창 닫기)·`F5`가 이제 터미널에 도달.
  복사/붙여넣기(Edit) role은 유지해 입력창 편집은 그대로. DevTools/줌/전체화면 유지
- **데스크톱 복사/붙여넣기 + 우클릭 컨텍스트 메뉴 (M2):** xterm에서 `Ctrl+Shift+C`(선택 복사)·
  `Ctrl+Shift+V`(붙여넣기), 우클릭 시 복사/붙여넣기/전체선택 메뉴(xterm·plain 공통)
- **모바일 롱프레스 컨텍스트 메뉴 (M3):** 터미널 롱프레스로 복사/붙여넣기/전체선택
- **입력 충실도 (M4):** 실행 중 plain 프로그램에 표준 터미널 키 전달 — Escape·화살표·Home/End·
  Delete·PageUp/Down·F1–F12·`Ctrl+<letter>` 제어 바이트. IME/CJK 조합 입력 지원(데스크톱·모바일),
  모바일 물리 키보드 라우팅
- **스크롤백 설정 (M5):** xterm 스크롤백 줄 수를 설정에서 조절(기존 5000 고정)

### Notes
- Tier-3 xterm 렌더링 애드온(web-links·unicode11·webgl)은 이번 릴리스에서 보류 — `@xterm/xterm`
  6.0.0과 호환되는 stable 애드온 릴리스가 아직 없음(npm엔 xterm 6.1.0-beta 트래킹 beta만 존재)

## [0.6.7] - 2026-07-08

### Added
- **CRT 치직 간섭 이펙트 4종 (crt-interference):** 브라운관 수신불량 느낌의 새 이펙트 세트 — 전부
  독립 토글 + 전용 슬라이더, 자유 조합, 데스크톱·모바일 공통 (기본 OFF, Matrix 테마가 선언)
  - **Burst Jitter:** 설정한 주기마다 화면 전체가 순간적으로 툭툭 튀는 간섭 버스트
    (주기 1–30s / 버스트 길이 50–1000ms / 강도 1–20px / 치직 순간 노이즈 플래시 동기 표시 옵션)
  - **Micro Jitter:** 끊임없는 1–5px 미세 떨림 (속도 / 진폭)
  - **Static Noise:** 정전기 스노우 오버레이 (입자 밀도 / 투명도 / 셔플 속도)
  - 파라미터는 이펙트별 슬라이더로 실시간 조절·영속화 (데스크톱 settings.json `effectParams`,
    모바일 localStorage `ezterminal-mobile-effect-params`)

### Fixed
- **Flicker 이펙트 정상화:** 카탈로그에만 있고 어느 테마도 선언하지 않아 보이지 않던 유령 상태
  + 스캔라인이 켜져 있어야만 동작하던 결합 제거 — 이제 Matrix에서 노출되고 단독 동작하며
  빈도(1–30Hz)/깊이(1–40%) 파라미터로 조절 가능 (기존 0.15s/0.92 감각이 기본값)

## [0.6.6] - 2026-07-08

### Changed
- **롤바 기본값 개편 (wide/faint/soft):** Matrix 기본 롤바를 하드 스트라이프 대신 은은한 저속 CRT
  글로우 밴드로 — 두께 120px·간격 70%·색 `#5fe7ac`(Matrix `--term-fg`)·속도 1(한 줄이 화면을 24s에
  가로지름)·투명도 20%·그라데이션 softness 100%. **기본값만 변경**(이미 저장된 설정은 불변). CSS var
  폴백도 동일 값으로 미러(70vh 피치·16.8s/주기·0.2 opacity·60/60px 그라데이션 스톱)

## [0.6.5] - 2026-07-08

### Changed
- **롤바를 심리스 컨베이어로 재설계:** 이전 스윕 밴드는 밴드 전체가 루프당 두 뷰포트를 이동해 100%
  spread에서도 다음 패스 전에 화면이 비었음 — 오버레이를 화면보다 한 피치 크게 만들고 한 피치 위에서
  시작해 루프당 정확히 한 피치만 아래로 이동(패턴 주기 == 이동 거리 → 리셋이 동일 프레임에 안착, 화면이
  비지 않음). 한 줄이 나가면 다음 줄이 같은 피치로 위에서 진입
- **line count 제거:** 보이는 줄 수는 간격에서 파생(기존 저장된 `count` 값은 파싱만 하고 무시). gap =
  컨베이어 피치(화면 높이 %, 1–100, 기본 10; 슬라이더명 "Line spacing"), 속도는 화면상대(한 줄이 화면
  통과 = 24/speed s), **두께 상한 10px → 200px**(두꺼운 밴드에서도 softness·opacity 유지)

## [0.6.4] - 2026-07-08

### Added
- **롤바 opacity + per-line gradient softness 컨트롤** (Settings → Effects, 데스크톱+모바일, 라이브+영속):
  - opacity 0–100%(기본 90) → 밴드 `--fx-rollbar-opacity`
  - gradient softness 0–100%(기본 70) → 각 줄의 동일 fade-in/out 형태(0 = 하드 솔리드 엣지, 100 = 완전 삼각 fade)

## [0.6.3] - 2026-07-08

### Changed
- **롤바 spread + 균일 줄:** gap을 **spread%**(0–100)로 전환 — 100에서 첫 줄이 화면 최상단·끝 줄이 최하단,
  나머지는 균등 피치(0이면 줄이 맞닿음). 밴드 높이/피치는 `applyRollbarParams`가 `calc()` 문자열로 파생,
  count=1은 단일 줄로 특수 처리(divide-by-zero 피치·반복 아티팩트 방지)
- **모든 줄을 동일하게:** 밴드 레벨 가장자리 fade 마스크 제거(첫/끝 줄이 어두워지던 것) → 각 줄이 자기
  두께 안에서 동일한 soft in/out 그라데이션. 기본 gap 4px → 100%, 슬라이더명 "Line spread: N%"

## [0.6.2] - 2026-07-08

### Added
- **사용자 조절 CRT 롤바:** crt-rollbar를 count/thickness/gap/color/speed 5제어(Settings → Effects,
  데스크톱+모바일, 영속·라이브)로 — `effect-params.ts` `RollbarParams`(기본 10/2/4/`#c8ffe6`/4), clamp
  (count 1–40·thickness 1–10·gap 0–30·speed 1–20·color는 theme-schema `isColorValue` 검증),
  `applyRollbarParams`가 `--fx-rollbar-count/-thickness/-gap/-color/-duration` 주입(duration = 24/speed s).
  영속은 effectToggles와 동형(데스크톱 `window.ezterminalDesktop` get/setRollbar → settings.json, 모바일
  localStorage `ezterminal-mobile-rollbar`)

## [0.6.1] - 2026-07-08

### Added
- **움직이는 CRT "roll" 이펙트 2종:** v0.6.0 카탈로그는 정적 스캔라인 + 미약한 flicker + 정적 vignette뿐이라
  Matrix로 바꿔도 무변화로 보이고 실제 "줄 내려가는" 모션이 없었음 — 독립 토글 2종 추가:
  - **crt-rollbar:** 5.5s 루프로 위→아래 스윕하는 soft-bright 가로 밴드(구형 CRT 수직동기 roll).
    `body::after`, 스캔라인 오버레이 위 z-index, transform-only 애니메이션(GPU 저비용), pointer-events:none
  - **scanline-scroll:** 가로 스캔라인 패턴이 연속 하강(정적 `scanlines` 오버레이와 구분). `body::before`,
    background-position만 애니메이트
  - 둘 다 Matrix 데스크톱 기본 ON(즉시 보이도록)·모바일 기본 OFF(배터리), 각각 독립 Settings 토글.
    스키마는 `EFFECT_CATALOG`에서 id 자동 인식(`KNOWN_EFFECT_IDS`)

## [0.6.0] - 2026-07-08

### Added
- **확장형 테마 mod (moddable themes):** 하드코딩 4테마를 확장·모딩 가능한 시스템으로 — 테마 mod =
  검증 JSON(Zod `ThemeModSchema`: id charset 제한·`CSS.escape`, cssVars 키/값 화이트리스트·크기 상한,
  임의 CSS 금지). 레지스트리 리졸버 `getActiveTheme()`가 크롬(주입 `#ez-theme-vars` CSS vars)·터미널(xterm)
  **양쪽 레지스트리 인지**(ThemeName enum → string). 데스크톱=폴더 스캔(`EZTERMINAL_THEMES_DIR`)+인앱
  Import(모바일 TS2420 회피 위해 `EzTerminalApi` 아닌 데스크톱 전용 `window.ezterminalDesktop`), 모바일=인앱
  Import + localStorage 레지스트리
- **토글형 이펙트 카탈로그:** 이름 붙은 카탈로그(scanlines / phosphor-glow / flicker / crt-curvature)를
  `html[data-effect-*]` 키로 — Matrix의 CRT CSS를 여기로 리팩터. 이펙트별 토글(데스크톱=테마 기본값 추종,
  모바일=기본 OFF)
- **번들 폰트 피커:** `FONT_CATALOG`(self-host woff2 — Share Tech Mono / JetBrains Mono / Fira Code +
  Cascadia 시스템 엔트리), 사용자 override는 터미널 생성 시점 + 라이브 적용
- 데스크톱 Electron 앱 + Capacitor 안드로이드 앱 공유 렌더러 양쪽에 적용

## [0.5.1] - 2026-07-07

### Fixed
- **화면 클릭 포커스 복구 + 제출 시 입력창 클리어(데스크톱):** 터미널 화면 영역을 클릭하면 cmd-input에
  포커스가 복귀(텍스트 선택·xterm·버튼 클릭은 제외)하고, 명령 제출 시 입력창을 비운다

## [0.5.0] - 2026-07-06

### Added
- **컨트롤 핸드오프:** 미러(폰/보조 페인)의 실행 중 터미널에 "Take control" 버튼 — 누르면 그 기기가
  리사이즈 권한을 가져와 공유 PTY가 그 기기 크기로 재배치되고(TUI가 꽉 참), 반대쪽이 미러로 전환.
  컨트롤 보유 기기가 끊기면 살아있는 쪽으로 자동 복귀 (에뮬레이터 왕복 검증: 폰 클레임→데스크톱 재클레임)

### Changed
- **미러 자동축소(shrink-to-fit):** 미러는 이제 컨트롤 보유 기기의 그리드를 가로 스크롤 대신 화면 폭에
  맞춰 글자를 자동 축소해 전체가 한눈에 보이게 렌더 (최소 6px, 넘치면 그때만 스크롤)
- 자동응답 억제(v0.4.0)가 고정 미러 플래그 대신 실시간 컨트롤 상태를 따름 — 컨트롤을 잃은 쪽이 억제되고
  가져온 쪽이 터미널 질의에 응답

## [0.4.0] - 2026-07-06

### Fixed
- **모바일 미러링 (레벨-트리거 attach):** 데스크톱에서 이미 실행 중인 run(claude 같은 TUI 포함)에
  모바일이 뒤늦게 접속/세션 오픈해도 이제 라이브로 보인다 — run 발견이 `run-started` 1회 브로드캐스트뿐이라
  늦게 붙는 클라이언트가 attach 대상을 알 수 없던 것이 원인. 새 `list-runs` 조회로 세션 뷰 마운트·재접속 시
  진행 중 run에 자동 attach (에뮬레이터 라이브 왕복 검증)
- **미러 리사이즈 게이트:** 미러(폰/보조 페인) xterm의 fit이 공유 PTY를 자기 크기로 리사이즈해 프라이머리
  화면을 흐트러뜨리던 문제 — `pty-resize`는 프라이머리 포트 전용으로 게이트, 미러는 새 `pty-dims` 프레임이
  전달하는 프라이머리 치수 그대로 렌더(넘치면 가로 스크롤)
- **미러 자동응답 주입:** 미러 xterm이 리플레이/라이브 바이트 속 터미널 질의(DA/DSR)에 자동 응답해 공유 PTY
  입력을 오염시키던 문제(`^[[?1;2c`가 명령 앞에 붙음) — 미러는 write 파싱 중 발생하는 onData를 무시
- **데스크톱 동일 갭:** Ctrl+R 리로드·레이아웃 복원으로 세션을 재-adopt한 페인도 진행 중 run에 자동 attach

### Added
- 프로토콜: `list-runs`/`run-list` 왕복(데스크톱 IPC + 원격 WS 브리지 전 경로) + `EzTerminalApi.listRuns`,
  인터프리터 `pty-dims` 프레임(attach 리플레이 시 링 바이트보다 먼저 전달)

## [0.3.0] - 2026-07-06

### Changed
- **설정 중복 제거:** 설정 드로어(데스크톱⚙️/모바일)의 테마 섹션 제거 — 테마 전환은 데스크톱 헤더
  "Theme:" 순환 버튼과 모바일 🎨 ThemeMenu로만 남김(둘 다 기존과 동일하게 동작)

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
