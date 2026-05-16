# Harness Structural Gap: Build Artifact Identity

> 2026-05-16 — EZTerminal 구현 과정에서 반복 발생한 "e2e PASS / 실앱 FAIL" 문제의 구조적 원인 분석.
> 대상: EZPowers 하네스 (choiceexecutor, pipeline-audit, smoke gate)
> **Status:** Root cause (vite.main.config.ts missing chokidar external) resolved. Fix A (Distribution Smoke) implemented.

## 문제 요약

| | E2E 테스트 경로 | 실제 배포 경로 |
|---|---|---|
| 번들러 | esbuild (`scripts/build-e2e.mjs`) | vite plugin (`@electron-forge/plugin-vite`) |
| Main define | `--define:MAIN_WINDOW_VITE_DEV_SERVER_URL=""` (수동) | vite plugin이 빌드시 주입 |
| node_modules | 개발 환경에 존재 → `--external`이지만 resolve 가능 | asar에 미포함 → require 실패 |
| native modules | 개발 node_modules에서 직접 로드 | `app.asar.unpacked` 필요 (미포함 시 crash) |
| 실행 대상 | `.vite/build/index.js` (loose file) | `out/*/ezterminal.exe` (packaged asar) |

**결과:** 368 unit/component tests PASS, 20+ e2e tests PASS, typecheck PASS, lint PASS — 하지만 실제 exe 실행 시 에러 팝업.

## 반복 패턴 (수회 확인)

1. Subagent가 구현 + 테스트 작성
2. Controller가 Verify commands 실행 → ALL PASS
3. Smoke gate (`pnpm test:e2e --grep smoke`) → PASS (또는 해당 테스트 미존재로 skip)
4. `electron-forge package` → exe 생성
5. exe 실행 → native module require 실패 → 에러 팝업

## 하네스에서 검출하지 못하는 5가지 구조 결함

### 1. `config.smoke.command`가 배포 산출물을 검증하지 않음

**현재 동작:**
```json
"smoke": { "command": "pnpm test:e2e --grep smoke" }
```
이 명령은 `.vite/build/index.js`를 Playwright로 실행합니다. packaged exe(`out/*/ezterminal.exe`)를 한 번도 실행하지 않습니다.

**choiceexecutor Section 14 원문:**
> Smoke/runtime gate: Run the configured runtime probe. If `config.smoke.required: true`, missing `config.smoke.command` is FAIL.

→ "command 실행 → exit 0 = PASS"로만 판단. 해당 command가 배포 산출물과 동일 경로인지 검증하는 메커니즘이 없음.

### 2. pipeline-audit D2 (Verify Executability)에 "Build Identity" 검증 없음

**D2가 검사하는 것:**
- 도구 존재 (`command -v`)
- 포트 정합성 (config.server vs Verify command)
- 파일 경로 존재 (test files in Create list)
- 환경 변수 참조

**검사하지 않는 것:**
- e2e 테스트의 launch target과 production build의 output이 동일 번들러/설정인가?
- `config.smoke.command`가 배포 산출물을 직접 실행하는가?
- 테스트 빌드 스크립트(build-e2e.mjs)와 forge 빌드의 `external` 처리가 동일한가?

### 3. 의존성 위치(deps vs devDeps) 검증 부재

**구체 사례:**
- `node-pty`가 `devDependencies`에 위치
- `pnpm typecheck` → PASS (타입만 검사, 런타임 무관)
- `pnpm test` → PASS (개발 node_modules에서 resolve)
- `pnpm test:e2e` → PASS (esbuild `--external` + 개발 환경에 모듈 존재)
- `electron-forge package` → `pnpm install --prod` → node-pty 미설치 → require 실패

**pipeline-audit D4 (File Mutation Consistency):**
소스 파일의 Create/Modify 순서만 검사. `package.json`의 dependencies/devDependencies 분류를 검증하지 않음.

**pipeline-audit D2 Dependency Resolution (현재):**
> For packages referenced in Verify commands but NOT in manifest: WARN

→ manifest에 "있기만 하면" PASS. deps/devDeps 위치까지 검증하지 않음.

### 4. GUI Smoke의 "process survival" 검증이 테스트 빌드에서만 수행됨

**choiceexecutor Section 14 GUI smoke:**
```
gui_strategy: "headless" → run config.smoke.command as headless test runner
```

headless test runner(Playwright)가 실행하는 대상: `.vite/build/index.js` (loose file, 개발 node_modules 접근 가능)

**배포 exe에 대한 검증:**
- 프로세스 8초 생존 → 미수행
- stderr 패턴 체크 → 미수행
- 창 존재 확인 → 미수행
- 스크린샷 → 미수행

### 5. /grill-with-docs, /pipeline-audit가 빌드 경로 동치성을 질문하지 않음

`/grill-with-docs`의 스트레스 테스트 범위: 설계 결정, 도메인 모호성, 아키텍처 트레이드오프.
"e2e 빌드 경로 = production 패키징 경로" 검증은 인프라/DevOps 레벨이며 현재 하네스 관심 범위 밖.

## 필요한 구조 보완

### A. Distribution Smoke Gate (choiceexecutor Section 14 확장)

현재 smoke가 "Test Smoke"만 존재. "Distribution Smoke"를 2nd tier로 추가:

```
config.smoke:
  test_command: "pnpm test:e2e --grep smoke"          # 빠른 피드백 (test build)
  distribution_command: "<package-cmd> && <exe-path>"  # 실제 배포 검증
  distribution_timeout: 30
```

**Distribution Smoke 검증 항목:**
1. `config.build.command` (또는 forge package) 실행 → exit 0
2. 결과 exe/app 실행 → process survival (`survival_seconds`)
3. stderr에 `config.smoke.stderr_fail_regex` 미출현
4. (desktop) Window handle 존재 확인

**Gate 위치:** choiceexecutor Section 14, Test Smoke PASS 이후 추가 단계로.

### B. Build Artifact Identity Check (pipeline-audit D2 확장)

새 sub-check in D2:

```
D2.11: Build Artifact Identity
- e2e 테스트의 app launch 경로 추출 (tests/e2e/*.ts에서 MAIN_ENTRY/executablePath 패턴 검색)
- config.build.command 또는 forge config의 build output 경로 추출
- 비교:
  - 동일 파일 → PASS
  - 다른 파일이지만 동일 빌드 시스템 → WARN
  - 완전히 다른 빌드 시스템 (esbuild vs vite) → FAIL
    "E2e tests exercise a different build artifact than production packaging.
     Test: .vite/build/index.js (esbuild). Production: electron-forge (vite plugin).
     Results are not transferable."
```

### C. Dependency Location Gate (pipeline-audit D2 또는 D4 확장)

```
D2.12: Runtime Dependency Location
- vite/esbuild main config에서 `external` 목록 추출
- 각 external이 package.json에서 어디에 있는지 확인:
  - `dependencies` → PASS
  - `devDependencies` → FAIL
    "node-pty is external in build but in devDependencies.
     Production install (--prod) will not include it. Move to dependencies."
  - `optionalDependencies` → PASS (graceful degradation expected)
  - 미존재 → FAIL ("External module not in any dependency section")
```

### D. Implementer Prompt 보강

`agents/implementer-prompt.md`의 "Before You Begin" 또는 "Scope Guard"에:

```
## Build Verification (desktop/server artifacts)
Before reporting DONE for {skeleton} or final tasks:
1. Run the project's actual packaging command (not the test build)
2. Launch the packaged artifact
3. Confirm it starts without error for at least 5 seconds
4. If packaging differs from test build, report DONE_WITH_CONCERNS
```

## 근본 원인 한 줄 요약

**하네스가 "테스트가 증명하는 것 = 유저가 실행하는 것" 동치성(Build Artifact Identity)을 보장하는 게이트가 없다.**

테스트 통과 = 기능 동작이라는 가정은 테스트와 배포의 빌드 경로가 동일할 때만 유효하다. Electron + native modules + pnpm 조합에서 이 가정이 특히 자주 깨진다.

## 적용 우선순위

1. **Distribution Smoke (A)** — 가장 직접적. exe 실행 → 생존 확인만으로 90% 문제 차단.
2. **Dependency Location Gate (C)** — 저비용 정적 분석. deps/devDeps 오분류 즉시 감지.
3. **Build Artifact Identity Check (B)** — 중기. 빌드 시스템 분석 필요.
4. **Implementer Prompt 보강 (D)** — 문화적 변화. 효과 제한적이지만 비용 0.

## Applied Fixes (2026-05-16)

### Fix 1: vite.main.config.ts externals 정렬

**근본 원인 해결.** `chokidar`를 `vite.main.config.ts`의 `rollupOptions.external`에 추가.
Vite 프로덕션 빌드가 `require("chokidar")`를 emit하도록 하여, `build-e2e.mjs` 및 `forge.config.ts` ASAR unpack 목록과 동기화.

### Fix 2: Externals 동기화 검증 (`scripts/verify-externals.mjs`)

`src/main/`의 실제 import를 기준으로 세 파일(vite, esbuild, forge)의 externals 목록 자동 비교.
- import되는 모듈이 어느 설정에서든 누락 → FAIL
- 설정에만 존재하고 import 없음 → WARN
- `pnpm verify:externals`로 실행.

### Fix 3: Distribution Smoke (`scripts/dist-smoke.mjs`)

제안 A (Distribution Smoke Gate) 구현.
- `electron-forge package`로 패키징
- exe 실행, 8초 생존 확인
- stderr에서 crash 패턴 검사 (`Cannot find module`, `MODULE_NOT_FOUND`, `ERR_REQUIRE_ESM`, `SyntaxError`)
- `pnpm dist:smoke`로 실행.

### Fix 4: 구현 플랜 업데이트

- SI-6 (external 목록 동기화), SI-7 (distribution smoke) 구조 불변량 추가.
- T8, T9, T10, T11, T12의 Verification method에 `pnpm dist:smoke` 추가.
- Full-Feature Wiring Gate에 Distribution Gate 추가.

### Remaining (미적용)

- **B: Build Artifact Identity Check** — pipeline-audit D2 코드 변경 필요.
- **C full: 자동 의존성 위치 스캔** — verify-externals.mjs가 부분 커버, 전체 자동화는 추후.
- **D: Implementer Prompt 보강** — 문화적 변화, 비용 0이지만 효과 제한적.
