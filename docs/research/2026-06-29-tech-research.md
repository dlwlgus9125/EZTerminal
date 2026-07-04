# EZTerminal 기술 리서치 결과 (2026-06-29)

> deep-research 워크플로우 산출 (6각도, 32소스 수집, 152 claims → 25 검증 → 11 합성, 0 기각).
> 모든 finding은 3-0 만장일치 적대적 검증 통과. 출처는 1차 공식 문서 위주.
> **이 문서는 영속 기록 — 아키텍처/빌드 결정의 근거.**

---

## Area 1 — 구조화 셸 선행 사례

### F1. Nushell 값 타입 시스템을 셸 코어 데이터 모델 청사진으로 채택 (high)
3개 합성 타입으로 충분, 임의 중첩 가능:
- **list**: 임의 타입 값의 순서 있는 시퀀스
- **record**: 문자열 키 ↔ 값 (JSON 객체류)
- **table**: 2차원(열/행) 컨테이너 = **내부적으로 "list of records"** → 한 행 추출 시 record가 됨
- (스칼라: int/float/string/bool/date/duration/filesize/path)
- 출처: https://www.nushell.sh/book/types_of_data.html

### F2. 파이프라인은 타입 있는 구조화 값을 전달 (문자열/호스트객체 X) (high)
- 모든 명령이 예측 가능한 **구조화 입력**을 받음. 이것이 PowerShell(.NET 객체 전달)과의 핵심 차별점.
- → 프로젝트 제약("자체 셸이 네이티브로 구조화 생성")과 정확히 일치.
- ⚠️ **중요 단서:** 구조화 보장은 **내장 명령**에만. **외부 프로그램**(git 등)은 raw 바이트/문자열 스트림 → 외부 프로세스 출력을 파이프라인에 다시 넣을 때 주의 (Area 4 연결).
- 출처: https://www.nushell.sh/book/coming_from_powershell.html

### F3. 블록 UI를 Warp처럼 모델링 (high)
- 터미널의 기본 단위 = **Block**: 한 명령의 입력(프롬프트+명령) + 그 출력을 하나의 자족적 시각 단위로 묶음.
- 단일 문자 그리드가 아니라 **블록의 순서 있는 타입 리스트(BlockList)**가 세로로 쌓여 함께 스크롤. 내부적으로 블록 = command-side grid + output grid.
- 출처: https://docs.warp.dev/terminal/blocks/block-basics/ , https://www.warp.dev/blog/the-data-structure-behind-terminals , https://www.warp.dev/blog/block-model-behind-warps-agentic-development-environment

### F4. 대량 출력은 2단계 가상화 (high)
- ① 뷰포트와 겹치는 블록만 렌더 → ② 그 블록 안에서 겹치는 행만 렌더.
- Warp는 SumTree(균형트리)로 O(log n) 조회하지만, 이는 **Rust/GPU 구현 디테일 → React엔 직접 이식 안 됨**. **패턴만 이식**(react-window / TanStack Virtual).
- 출처: 위 Warp 블로그.

---

## Area 3 — 명령 블록 UI (React)

### F5. 표 데이터는 headless 테이블 + 별도 가상화 라이브러리 조합 (high)
- **TanStack Table v8은 가상화 내장 없음** — 의도적으로 외부 가상화 라이브러리(react-window 또는 TanStack Virtual)와 조합하도록 설계.
- headless = 상태관리와 렌더링 분리 → 블록 UI에 맞춤 렌더 가능.
- 출처: https://tanstack.com/table/v8/docs/guide/virtualization

(F3, F4도 Area 3에 적용.)

---

## Area 4 — Electron 외부 프로그램 실행

### F6. 실시간 스트리밍은 child_process.spawn (high)
- spawn은 기본 stdio로 stdin/stdout/stderr 파이프 생성 → `subprocess.stdout.on('data', ...)`로 실시간 캡처.
- 버퍼링형 API(`exec`·`execFile`)는 출력을 전부 모은 뒤(maxBuffer 한계) 콜백으로 전달 → 스트리밍엔 부적합.
- 출처: https://nodejs.org/api/child_process.html

### F7. 알려진 프로그램은 셸 없이 직접 spawn (execFile / args 배열) — 단 Windows .bat/.cmd 주의 (high)
- execFile은 셸을 안 띄움 → 셸 메타문자 인젝션 방지. git/node/python은 .exe라 직접 spawn 가능.
- ⚠️ **Windows .bat/.cmd는 execFile로 실행 불가** → `shell:true` 또는 `spawn('cmd.exe', ['/c', 'my.bat'])`. (CVE-2024-27980 / DEP0190: .bat/.cmd spawn은 shell:true 없으면 throw)
- 출처: https://nodejs.org/api/child_process.html

### F8. ANSI 색은 ansi_up으로 HTML 변환 (high)
- ANSI SGR 코드 → `<span>` + 인라인 스타일/CSS 클래스 (색·bold·italic·underline·faint).
- **stateful 스트리밍 API(v2.0+)**: HTML 증분 출력, 불완전 ESC/OSC 시퀀스는 완성될 때까지 버퍼 → 청크 경계로 잘린 escape 코드에 적합.
- ⚠️ SGR 스타일링만 (커서/전체 터미널 제어 X) → 풀스크린 TUI는 xterm.js 필요(2차).
- 출처: https://github.com/drudru/ansi_up

---

## Area 5 — 프로젝트 셋업

### F9. Electron Forge + Vite는 분리된 2개 config (high)
- `vite.main.config.js`(메인) + `vite.renderer.config.js`(렌더러). 타깃별 별도 빌드(렌더러 병렬 먼저 → 메인/프리로드).
- (스캐폴드 템플릿은 vite.preload.config 포함 3개 쓰기도 함. Forge v7.9.0에 `concurrent` 옵션 추가됨.)
- 출처: https://www.electronforge.io/config/plugins/vite

### F10. native module은 자동 번들 안 됨 — external 선언 + 패키징 시 복사 (high)
- `build.rollupOptions.external`에 선언(예: serialport, sqlite3)해 외부 패키지로 로드. **추가로 패키징 시점에 패키지로 복사**해야 함.
- → 메모리의 packageAfterPrune-hook 요구와 일치 (1차엔 native module 없으니 2차 node-pty 도입 때 적용).
- 출처: https://www.electronforge.io/config/plugins/vite , https://github.com/electron/forge/issues/3917

### F11. IPC 보안 = context isolation + 좁은 contextBridge 래퍼 (high)
- context isolation은 Electron 12부터 기본 — 프리로드/내부 로직을 웹 콘텐츠와 별도 JS 컨텍스트에서 실행.
- `contextBridge.exposeInMainWorld(key, api)`로 안전한 양방향 동기 브리지 → `window[key]`에 주입. (isolation 하에선 `window.myAPI=...` 직접 할당 안 됨)
- ⚠️ **ipcRenderer 전체 노출 금지**(빈 객체 반환 + 보안 footgun) → 특정 채널만 좁게 래핑해 노출.
- 출처: https://www.electronjs.org/docs/latest/api/context-bridge , https://www.electronjs.org/docs/latest/tutorial/context-isolation

---

## ⚠️ 스코프 갭 (리서치로 답 안 됨 — 오픈 퀘스천, 후속 필요)

검증 통과 claim이 **없는** 영역. "답을 찾았다"고 취급 금지:

1. **Area 2 인터프리터 구현 메커니즘** (셸 코어의 심장 — 미해결):
   - 렉서/파서 접근: 수작업 재귀하강 vs 파서 콤비네이터(chevrotain/parsimmon) vs PEG(peggy)?
   - 파이프라인 실행 엔진: 구조화 값을 스트리밍/lazy iterator vs 일괄 평가?
   - builtin 명령 디스패치/등록 구조 (시그니처 타이핑, 입출력 타입 계약)?
   - *(값 타입 시스템 F1만 근거 있음 — 나머지는 무근거)*
2. **Area 6 (2차) 전체 미커버:**
   - node-pty + xterm.js TUI 통합 (Windows ConPTY), 문자그리드 PTY 뷰 ↔ 블록 UI 조화 방식
   - zx / Bun Shell에서 JS/TS 임베드 스크립팅 차용 (템플릿 리터럴 명령 문법, ProcessOutput 모델)
   - *(소스는 수집됨: xterm.js, bun shell 블로그, zx repo — 단 검증 통과 claim 미생성)*

---

## 시간 민감성 / 정밀 단서
- Electron Forge Vite 플러그인 활발히 진화(v7.9.0 concurrent). Node .bat/.cmd spawn 동작 2024 보안릴리스로 변경(DEP0190). context isolation은 Electron 12(2021)부터 기본 — 구현 시점 정확 버전 재확인.
- Nushell 구조화 보장은 내장 명령 한정(외부는 텍스트). 무셸 execFile이 보안 기본이나 Windows .bat 예외. ansi_up은 SGR만.

## 전체 소스 (품질 표기)
주요 1차: Nushell book, Node.js docs, Electron docs, Electron Forge docs, TanStack Table, ansi_up repo, xterm.js repo, bun.sh/blog, github/google/zx. (32개 수집, 11개 finding 근거)
