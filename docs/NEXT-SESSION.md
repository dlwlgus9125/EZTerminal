# EZTerminal — 다음 세션 이어가기 (Resume Handoff)

> 마지막 릴리스: **2026-07-08, v0.6.7** (main @ `ce3a087`). **결정 없이 진행 가능한 작업 전부 완료** —
> 토대: Stage 0·A·C·D + B(M4만 잔여) + E1 테마·E2 팔레트·E4 스크립팅·E5 SSH + CLI 패리티·번들 ConPTY +
> 시스템 상태 패널 v1/v2·실시간 패킷 캡처 + Matrix(CRT) 테마 + **모바일 원격 제어·미러링·컨트롤 핸드오프**
> (안드로이드 앱) + E6 크로스플랫폼 ps 부분(유닛). **그 위로 v0.2.0~v0.6.7 배포**: 설정 UI/UI 스케일/원격
> 토글(v0.2.0)·설정 중복 제거(v0.3.0)·미러 attach(v0.4.0)·컨트롤 핸드오프+shrink-to-fit(v0.5.0)·화면클릭
> 포커스+제출 클리어(v0.5.1)·**확장형 테마 mod+토글 이펙트+폰트 피커(v0.6.0)·CRT 롤바→심리스 컨베이어
> (v0.6.1~v0.6.6)·CRT 간섭 4종(v0.6.7)**.
> **모바일 원격 제어는 main에 있음** — PR #3(`74e998f` squash-merge)로 반영됨(옛 `feat/mobile-remote-control`
> 브랜치는 그 pre-squash 원본이라 main의 ancestor 아님 = stale, 정리 후보).
> 플랜 원본: `~/.claude/plans/zesty-wiggling-pony.md` (Stage 0→A→B→C→D→E, 실행 로그 포함).
> **실행 방식(유저 지시): 구현=Sonnet executor 위임, 리드(Fable)=게이트·리뷰·재현검증·커밋.**
> **원격/CI 가동**: `github.com/dlwlgus9125/EZTerminal`(**private**), GitHub Actions `windows-2022` 러너
> (`cap` 네이티브 빌드 픽스). **잔여는 사용자 결정 대기**: B-M4 자동업데이트·공개 전환=서명 결정, E3 AI=데이터 이그레스 동의.
> ⚠️ **문서 정합 주의:** git 태그는 v0.5.1 다음이 v0.6.7뿐 — **v0.6.0~v0.6.6 태그 누락**(릴리스 커밋은 존재).

## 프로젝트 한 줄
"기존 터미널 래퍼가 아니라 **자체 구조화 데이터 셸 + 명령 블록 UI**" (Warp 블록 + Nushell 데이터 + AI 계열). Electron + React + TypeScript, Windows 우선.

## 마일스톤 상세 아카이브 (2026-07-02~07-05 인프라·토대, 참고용)

> 현재 상태 요약은 위 헤더 + `docs/ROADMAP.md` 진행 현황 참조. 아래는 토대(영속·백프레셔·SSH·상태 패널·
> 모바일 브리지) 구축 시점의 상세 기록으로, v0.2.0~v0.6.7 배포는 이 위에 얹혔다.

### ✅ Track A ③ 프리셋·영속 완료 (앱 최초 영속 계층)
- **Codex 게이트 선행(A-M0):** verdict REVISE, 블로커 6건 전부 설계 반영 → `docs/research/2026-07-02-codex-track-a-presets-review.md` + `docs/design/layout-persistence-design.md`(GATED).
- **핵심 불변식(B1/B5): 복원은 절대 sessionId를 부활시키지 않는다** — 스키마가 params를 strict-빈으로 강제(스트립 아님·거부: 회귀 은폐 방지), 복원 패널은 TerminalPane mount 경로로 새 create-session. e2e가 재시작 후 "전부 새 sessionId + cwd 초기화"를 단언.
- 구성: `src/shared/layout-schema.ts`(버전드 Zod 엔벨로프, grid.root 사전검증=B1, 버킷 strip=B4, key=id·≤64패널=B5, maxTabSuffix) · `src/main/layout-store.ts`(원자 tmp→rename, stale tmp 청소, 직렬화 latest-wins, awaitable flush/quarantine, `.corrupt` 최신 1개 보존) · main IPC(`layout:*`/`presets:*`/`settings:*`, 전부 main측 재검증) · App.tsx **복원 트랜잭션**(세대 토큰=B2, 저장 억제 후 settle 시 리스너 부착=B3, tabCounter 재시드=F6, 300ms 디바운스, `__ezLayoutFlush`/`__ezSessions` seam) · TerminalPane createSession 취소 가드(StrictMode 누수 부채 (f) 해소) + `data-session-id`.
- **프리셋(A-M4):** 타이틀바 Presets ▾ 드롭다운 — 저장(인라인 입력; Electron엔 window.prompt 없음)/적용(confirm, 백업 후 fromJSON, 전 세션 새로)/★시작 프리셋(`settings.json`, 마지막 레이아웃보다 우선)/삭제.
- **e2e 격리 필수화:** 영속 도입으로 모든 launch가 격리 temp userData 필요 → `e2e/launch-app.ts` `launchApp(dir?)` (공유 dir 전달 시 재시작 시나리오). **새 스펙은 반드시 이 헬퍼 사용.**
- **seam:** `EZTERMINAL_USER_DATA_DIR` env → main이 ready 전 `app.setPath('userData')`.

### ✅ 프로덕션 인프라 (Stage 0 + B 부분)
- **CI:** `.github/workflows/ci.yml` — windows-latest 단일 잡: install→typecheck→lint→vitest→e2e→package→guard:native→packaged smoke. **GitHub 원격이 없어 실행은 대기** (아래 사용자 결정).
- **릴리스:** `.github/workflows/release.yml` — 태그 `v*` → 버전 일치 가드 → 전체 검증 → (secret 있으면 서명) → make → **draft** GitHub Release(Setup.exe+RELEASES+nupkg). publisher-github 대신 무의존성 action-gh-release.
- **서명(B-M3):** env-gated `windowsSign` — `WINDOWS_SIGN_CERT_FILE`/`_PASSWORD` 설정 시 exe+Setup.exe 서명(자체서명 pfx로 실증). 미설정=무서명(현재 기본). `docs/release/signing.md`.
- **인스톨러(B-M1):** 아이콘(플레이스홀더 — `node scripts/generate-placeholder-icon.mjs` 재생성)/win32metadata/Squirrel(setupExe/noMsi). `pnpm make` green. 수동 체크리스트: `docs/release/README.md`.
- **패키지 트림:** packageAfterPrune이 비-Windows prebuilds + winpty 소스(deps/) 제외 — signtool 차단 해소 + ~45MB 감량.
- **가드 하드닝(B-M6):** `isAppUrl`이 임의 file:// 대신 **앱 렌더러 index.html만** 허용.

### ✅ 품질 부채 (Stage D) — pnpm audit **0건**
- vitest 2.1→**3.2.6**(critical 해소) · vite 5.4→**6.4.3** + plugin-react **4.7**(latest=v6는 vite8 전용이라 불가; forge plugin-vite와 vite6 호환은 package 실행으로 실증) · overrides `tar>=7.5.16`/`tmp>=0.2.4` · `pnpm dedupe`(vitest 내부 vite 5.4.21 잔재가 esbuild/vite 경보의 실제 출처였음).
- ⚠️ tar 7 override는 @electron/rebuild의 ^6 위 — 현재 미실행 경로(node-pty=prebuilds)나, 향후 native 소스 컴파일 깨지면 이것부터 의심.
- parser dead `??` fallback 제거(Token 판별 유니온) · 프레임 어휘 addendum(설계 §3).

### ✅ Stage C 완료: PTY firehose 백프레셔 (바이트-ack)
- **Codex 게이트(REVISE 4블로커)** → boolean XON/XOFF 폐기, **바이트-ack 프로토콜**(행 credit 동형):
  렌더러(BlockController)가 xterm이 **실제 flush한**(term.write cb) 누적 바이트를 64KiB마다
  `pty-ack`로 보고 → 인터프리터(PtySession)가 `sent-acked > 1MiB`면 `pty.pause()`,
  `≤ 256KiB`면 resume. **pause 결정이 sent 카운터 쪽에 있어 in-flight(포트 큐+pre-sink 버퍼+
  xterm 대기)가 구성적으로 유계** (게이트 B2/B3). PtyHandle에 pause/resume 추가, 모든 종료
  경로는 resume-then-kill.
- **실측 2건(패키지드, wedge 2회 경험):** ① pause()는 ConPTY 워커 홉 너머 실제 native 배압
  ② **플레인 node 러너에서 hot-firehose에 in-process kill()은 이벤트 루프를 동기 wedge**
  (ClosePseudoConsole이 자기 배수자를 블록; 테스트/Playwright 타임아웃도 못 깸 → 외부 kill 필요).
  앱 경로(Electron utilityProcess)는 동일 시나리오를 dev e2e로 통과 → 패키지드 테스트는
  Ctrl+C 협조 종료 + resume 후 흐름 재개 단언. **교훈: 러너 프로세스에서 hot PTY를 kill하지 말 것.**
- seam: `window.__ezPtyFlow()` = {received, consumed}. e2e `pty-backpressure.spec.ts`.

### ✅ E1 테마 완료 (Sonnet 위임 1호)
- dark(기존 픽셀 동일)/light/high-contrast — `src/renderer/themes.ts` 단일 소스,
  `data-theme` 속성 + index.css `[data-theme]` 블록(수동 미러 — 주석 표기), PtyBlock은
  `ez:theme` 이벤트로 라이브 재테마(새 객체 spread 필수 — xterm 요구), 헤더 순환 버튼.
- 영속: SettingsSchema에 optional `theme`(버전 1 유지). **발견 버그: 구 setStartup이
  settings.json bare-overwrite → 테마를 지울 수 있었음 → write-chain 위 read-modify-write
  (`updateSettings`)로 교체.** 초기 getTheme fetch vs 빠른 클릭 레이스 가드 포함.
- light/HC 색상값은 임시 선정 — **시각 검수 필요** (플레이스홀더 성격).

### ✅ B-M5 크래시/진단 (로컬 전용)
- `crashReporter.start({uploadToServer:false})` + `userData/logs/main.log`(512KB 로테이션) +
  덤프 keep-10 + 인터프리터 크래시 배너(로그 경로 표시, dismiss 가능). e2e는 utilityProcess를
  **외부에서** 강제종료(재귀 자손 탐색 + kill 수 단언 — 조용한 no-match 방지).

### ✅ Stage C 부분: 렌더러 progress 스로틀 (계획 외 필수 수정)
- `gen-rows 100000000` 취소 e2e가 유휴 머신에서 **결정적** 실패(6연속) — "문서화된 flake"의 정체: progress 프레임(5천행당 1개×2만)마다 React 재렌더+rAF 레이아웃으로 메인스레드 포화→클릭 기아. 유휴 머신=인터프리터 가속=악화.
- 수정: `block-controller.ts` — progress만 leading+trailing 33ms 통지 스로틀(스냅샷은 매 프레임 갱신, end/error/cancelled/chunk는 즉시). 31s 타임아웃→2.8s 통과, e2e 스위트 2.1분→~1.2분.

### ✅ 추가 완료 (2026-07-03 ~ 07-04) — 상세는 `docs/ROADMAP.md` 진행 현황 참조
- **CLI 패리티**(sigil-free 자동 PTY·배치 shim·적응 렌더, verifier PASS AC 10/10) → **터미널 느낌 회복**(TUI 페인 테이크오버·인라인 프롬프트) → **번들 ConPTY**(`useConptyDll` — Win10 구형 ConPTY 스크롤백 결함 해소; kill은 `taskkill` 우회).
- **시스템 상태 패널 v1/v2**: CPU 코어 그리드·MEM 상세·NET 스파크·연결 목록·DISK/PROC(`systeminformation`) + **실시간 패킷 캡처**(`cap`+Npcap, off-by-default, 전용 `src/packet-capture/` utilityProcess).
- **Matrix(CRT) 테마**(4번째 빌트인, self-host woff2, 커밋 `ba213a7`).
- **모바일 원격 제어 (2026-07-05, 브랜치 `feat/mobile-remote-control`)**: 데스크톱을 안드로이드 앱에서 원격 제어(stats 제외). `EzTerminalApi`+MessagePort seam을 WS로 재구현(`src/main/remote-bridge.ts`, 토큰 인증)해 `BlockController`·블록 컴포넌트 **무수정 재사용**. Capacitor 앱(`mobile/`)+페어링 패널(M4)+에뮬레이터 e2e(`mobile/e2e/smoke.ts`). 재연결 auth 워치독으로 half-open 자가치유. 실기기+Tailscale 라이브 검증. **함정: `echo`는 이 셸 명령 아님(→`cmd /c echo hello`)·ws 번들 크래시(vite external)·androidScheme http·usesCleartextTraffic·tslib hoisted·Android SDK는 있으나 ANDROID_HOME 미설정.** 설계: `docs/design/mobile-remote-control-design.md`.
- **원격/CI**: `github.com/dlwlgus9125/EZTerminal`(private) 푸시, GitHub Actions `windows-2022` 러너로 가동.

## 검증 베이스라인 (로컬 전부 green, 2026-07-08 — v0.6.7)
```
pnpm typecheck   # 0   ← 리드 재현은 항상 여기부터 (E4 때 typecheck 생략 공백 교훈)
pnpm lint        # 0 (게이트 포함; .eslintrc가 mobile/ 제외)
pnpm test        # vitest 654 (테마 mod/이펙트/폰트/롤바/CRT 간섭 params 유닛 포함)
pnpm e2e         # 108 (launch-app.ts 격리 필수)
pnpm test:e2e:packaged  # guard OK + 8 (직결 모듈 스모크)
pnpm package / pnpm make # exit 0
pnpm audit --prod  # 0 vulnerabilities (전체 audit 7건은 @capacitor/cli>tar dev-only → prod 게이트로 정의)
# 모바일: pnpm --filter ezterminal-mobile run typecheck  # 0
#         pnpm --filter ezterminal-mobile run test        # vitest 104 (트랜스포트 + auth 워치독 + 테마/이펙트)
#         pnpm --filter ezterminal-mobile exec vite build  # dist/ OK  → cap sync android → gradlew assembleDebug → APK
#         mobile/e2e/smoke.ts  # 부팅된 AVD 필요 (ANDROID_HOME=…\Android\Sdk 세팅)
```
> ⚠️ 루트 `appicon.png`는 미추적 무관 파일(E5 무관, predates) — 커밋에서 제외 유지.
> ⚠️ ssh-session.test의 암호화키 KDF 테스트(bcrypt-pbkdf 실연산)가 병렬 부하 1회 transient
>    실패(재현 안 됨) — CI에서 재발 시 픽스처 KDF 라운드 하향 검토.
> ⚠️ **병렬 검증 금지:** 에이전트 여러 개가 동시에 e2e/package를 돌리면 공유 `.vite`/`out`이
> 충돌(EPERM 잠금)함 — 이번 세션에서 실제 발생. 검증은 한 번에 하나만.
> ⚠️ `.vite`/`out` stale 주의는 여전 (e2e 전 클린). CI가 클린 체크아웃으로 이 갭을 구조적으로 커버.

## 다음 작업 (우선순위순)
0. ~~E2 팔레트(aca4312)~~ · ~~E4 스크립팅(d7717fe — 게이트 4블로커 반영, script-host/ez.run/상한)~~ **완료.**
   E4 알려진 v1 제약: ez.run은 외부(byte-stream) 명령 미지원(구조화 rows 전용) · rows 반환 시
   stdout 폐기 · bare import는 스크립트 위치 기준. 후속 후보: ez.run 텍스트 모드.
2. **사용자 결정 대기 (블로커):** ① GitHub 저장소 **생성·푸시·CI 가동 완료(private)** — 남은 결정은 공개/비공개 전환(B-M4 업데이트 피드 게이트)·B-M2 릴리스 태깅 ② 서명 인증서(무서명 잠정 수용 중) ③ 실물 아이콘 아트 ④ 크래시 덤프 보존(last-10 제안) ⑤ E3 AI 보조 데이터 이그레스 동의
3. **B-M4 자동업데이트:** Squirrel+GitHub Releases(공개 저장소 필요). **자동 재시작 절대 금지** — 배너→사용자 restart.
4. **E3 AI 보조(인터뷰+Codex 게이트) → E6 크로스플랫폼(mac/linux 실검증)** (플랜 참조). E4 스크립팅·E5 SSH는 완료.
   실행 방식: 구현=Sonnet 위임, 게이트·리뷰·검증·커밋=리드.
5. 소소한 후속: light/HC 테마 색상 시각 검수 · IME/한글 e2e(제안) · **v0.6.0~v0.6.6 태그 소급 생성(누락 — 릴리스 커밋은 존재)** · stale `feat/mobile-remote-control` 원격 브랜치 정리.

## 아키텍처 요약 (재유도 금지 — LOCKED + addendum)
- 인터프리터=utilityProcess, main=브로커, renderer=UI. 명령당 MessagePort + credit 백프레셔 + ResultStore 윈도잉. **렌더러 통지는 progress 스로틀 33ms** (block-controller).
- 파서=수작업 lexer+Pratt (Token=판별 유니온: NumericToken.numeric 필수). 외부 실행=cross-spawn/Adapter, `!cmd`=node-pty ConPTY+xterm.
- **영속 계층: main만 fs 접근.** 새 영속 파일은 layout-store 패턴 복제(버전드 Zod 엔벨로프+원자쓰기+격리) — 3번째 스토어 등장 전 프레임워크화 금지 (E1 테마가 settings.json을 이 규칙으로 인수).
- 프레임 어휘 구현 델타는 설계 §3 addendum 참조 (progress/pty-data 추가, stderr/diagnostic/pause/resume 생략).

## 작업 규칙 (반드시)
와이어링 우선 · 가드 스크립트 필수 · 패키지 스모크 필수 · **복잡 아키텍처는 Codex 게이트 선행**(C 본체·E3+ 해당) · 가짜 완료 금지 · surgical 변경 · 마일스톤마다 커밋(Co-Authored-By) · **e2e는 launchApp() 격리 필수**

## 시작 절차
1. `cd C:\Working\EZTerminal` → `pnpm install`
2. `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e` green 확인
3. 위 "다음 작업" 1번(사용자 결정) 확인 → 2번부터 진행
