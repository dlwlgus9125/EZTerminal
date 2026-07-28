# EZTerminal 데스크톱 상용화 UI/UX — Claude Code 구현 핸드오프

> **원본 프로토타입**: `EZTerminal 데스크톱 프로토타입.dc.html` (인터랙티브, 이 문서의 시각적 진실 소스)
> **옵션 탐색 기록**: `EZTerminal 데스크톱 개선안.dc.html` (선택지 1a·1f·1g·1i·1l·1n·1o→페인채팅·1q 확정)
> **모바일 핸드오프**: `design_handoff_mobile_commercial_ui/` (공용 컨벤션 — 언어 토글, Matrix 강도 7 기준 동일)

## 0. 절대 제약 (모바일과 동일)

- **기능 파괴 금지.** 렌더러 UI 레이어만 변경. PTY/IPC/세션/페어링/보안/명령 시맨틱, Dockview 계약, 레이아웃 스키마(`shared/layout-schema.ts`), e2e `data-testid` 전부 유지.
- 기존 시맨틱 토큰(`src/renderer/styles/ui-tokens.css`)을 확장하되 이름 변경/삭제 금지. 신규 값은 토큰으로 추가.
- `docs/ux/frontend-design.md`의 4존 헤더 · 레일 순서 · 사이드바 단일 셸 · Command Center 소유권 규칙(§4.5)은 그대로 유효. 이 핸드오프는 그 위의 **시각·모션·밀도 사양**이다.
- reduced-motion 시: 부팅 시퀀스 스킵, 롤바/티커/펄스 정지 (기존 `MOVING_EFFECT_IDS` 게이트 재사용).
- KO/EN 동등 (`renderer/i18n/resources.ts`에 키 추가; 하드코딩 금지).

## 1. 확정 IA / 선택안 요약

| 표면 | 확정안 | 핵심 |
| --- | --- | --- |
| 앱 셸 | 1a 시그널 커맨드 바 | 브랜드 존1 강화 + 중앙 상시 검색 필드 |
| 작업영역 | 1f 포커스 글로우 카드 | 페인=카드, 포커스 글로우, 부유 컴포저, 레이아웃 프리셋 |
| Command Center | 1g 스포트라이트 | 중앙 모달, 그룹 결과, 키보드 완결 |
| Agent Hub | 1i 승인 큐 우선 | 위험도 색상, 인라인 승인/거부, 실행중 progress |
| Monitor | 1l 오실로스코프 | 스코프 파형 + 트래픽 워터폴 + 연결 목록 |
| Remote | 1n 링크 스테이션 + QR 패널 | 토폴로지 다이어그램, **QR 페어링은 전용 모달** |
| OpenClaw | 1o 콘솔 + **채팅=워크스페이스 페인** | 사이드바=콘솔, 채팅은 Dockview 패널로 도킹 |
| 다이얼로그/토스트 | 1q CRT 얼럿 프레임 | 위험도 탑바, 통계 3칸, 진행바 토스트 |
| 탐색기 | 브레드크럼 + 상위 이동 (추가 요구) | 전체 경로 표시, 세그먼트 클릭 네비게이션 |

## 2. 토큰 (ui-tokens.css 확장값)

Matrix 테마 기준 (기존 시맨틱 폴백과 동일 계열):

```
캔버스        #010301   서피스 #040a06 / raised #051009 / inset #020704
텍스트        primary #b7fbd4 · secondary #78dba5 · muted #5cbd87 · dim #3f8f63
보더          subtle #12301f~#17301f · mid #143523 · strong #245b3d · focus #2c6a47
액센트        #35e58f (on-accent #001c0d) · focus glow #8affba
정보 #62d8ff · 경고 #ffd166 · 위험 #ff6b7a (muted 배경: 색상 6~8% 혼합)
글로우        text-shadow 0 0 12~14px rgba(53,229,143,.5)
             box glow: 0 0 0 1px rgba(53,229,143,.25) + 0 0 28px rgba(53,229,143,.18)
라운드        페인/카드 12px · 모달 12~14px · 버튼/입력 5~7px · 칩/필 12~24px
타이포        크롬: 'Share Tech Mono' / 터미널: 'JetBrains Mono' (기존 --ui-font-terminal 유지)
             본문 한글: 기존 --ui-font-body (Segoe UI/Malgun)
CRT (FX 7)    스캔라인 repeating-linear-gradient(0deg, rgba(0,0,0,.20) 0 2px, transparent 2px 5px), opacity = fx/10+0.1
             롤바 150px 그라디언트 밴드, translateY 루프 8s linear (fx≥5 && motion)
             비네트 radial 60%→rgba(0,0,0,.4)
```

## 3. 모션 사양

| 대상 | 값 |
| --- | --- |
| 부팅 시퀀스 | 화면 open scaleY .004→1 (0.5s, cubic-bezier(.2,0,0,1)) → 빔 1s → 로고 페이드 → init 로그 5줄 ×320ms → 앱 전환. 총 ~3.2s, 클릭 스킵, 설정으로 비활성 가능 |
| 모달 (CC/QR/다이얼로그) | ezmodal: opacity 0→1 + translateY -8px + scale .97→1, 180ms cubic-bezier(.2,0,0,1) |
| 사이드바 전환 | 페이드+8px 상승 180ms (destination 교체 시 콘텐츠만) |
| 페인 포커스 | border/box-shadow/opacity transition 250ms; 비포커스 페인 opacity .82 |
| 토스트 | translateX 24px→0, 220ms; 4.2s 자동 소멸 |
| 터미널 신규 라인 | ezfadein 200ms (스트리밍 텍스트에는 미적용 — xterm 영역 제외) |
| progress/게이지 | width transition 1s linear (틱 동기) |
| 커서/승인 점멸 | steps(1) 1.1s / 1.4s |

## 4. 표면별 구현 명세 → 기존 파일 매핑

### 4.1 헤더 (workbench/AppHeader.tsx + BrandMark.tsx)
- 높이 60px. 좌→우: 시그널 3바(6px 폭, 10/17/24px 높이, drop-shadow glow) + 워드마크 26px + 버전칩 → 구분선 → `＋ 새 터미널` primary(36px, ezpulse 3s) → **중앙 검색 필드**(max 600px, `⌕ 명령·파일·세션·설정 검색` + Ctrl K 키캡, 클릭=Command Center) → `작업영역 ▾` → `FX·NEON n` 칩(정보색, 클릭=설정 Appearance) → 🔔+빨강 배지.
- 검색 필드는 QuickOpenModal 트리거의 시각적 앵커일 뿐, 상태 소유 금지 (§4.5).
- 4존 계약 유지: 검색 필드=Command Center 존의 확장 표현.

### 4.2 액티비티 레일 (workbench/ActivityRail.tsx)
- 폭 62px, 버튼 44px, 활성: bg #0b2416 + inset 3px 좌측 액센트 바 + 아이콘 #8affba.
- agents 배지: 승인 대기 수 (기존 attentionCount).

### 4.3 작업영역 (App.tsx Dockview 테마 + WorkspaceTab.tsx / TerminalPane.tsx)
- **페인=카드**: dockview 패널 컨테이너에 radius 12px, border #143523, 배경 #020805, gap 14px (dockview CSS 변수/테마 오버라이드로 구현 — 구조 변경 금지).
- 타이틀바 36px: 상태 점(8px, 색=세션 상태) + 제목 + 경로 메타 + 우측 배지(경과시간/RTT/승인) + ✕.
- 포커스 페인: border #2c6a47 + 글로우, 비포커스 opacity .82.
- 배경: radial-gradient(ellipse 90% 70% at 50% 30%, #04120a, #010301 70%).
- **부유 컴포저** (QuickCommandShelf.tsx 진화): 하단 중앙 820×48px 필, rgba(2,7,4,.94)+blur, 포커스 페인으로 라우팅. `/` Quick Command, 페이스트 경고 연동. 레이아웃 프리셋 칩(2×1/1+2/단일)은 workbench-coordinator의 기존 레이아웃 트랜잭션 호출.
- 승인 요청은 페인 내부 인라인 배너(노랑 6% 배경) — Agent Hub와 동일 액션 디스패치.

### 4.4 Command Center (QuickOpenModal.tsx 재스킨)
- 중앙 660px, top 84px. 헤더(⌕+입력+↑↓/Esc 키캡) / 그룹 헤더(10.5px, letter-spacing .12em, #3f8f63) / 행(선택: bg #0b2416 + inset 2px 액센트 + `Enter 실행 ↵` 힌트) / 푸터 키 힌트.
- 그룹: QUICK COMMAND · 이동 · 레이아웃 · 설정 (기존 row provider 유지).

### 4.5 Agent Hub (AgentHub.tsx)
- 섹션 순서: **승인 대기(위험도 정렬)** → 실행중 → 최근 활동 → 푸터(새 에이전트/설정).
- 승인 카드: danger=빨강 보더+점멸 점 / write=노랑. cmd는 모노 인셋 박스. [승인][거부][↗ diff].
- 실행중 카드: 상태 점 + 이름 + 3px progress + 경과(mm:ss 틱).

### 4.6 Monitor (StatusPanel.tsx)
- 스코프 카드(96px, 그리드 배경 24px, CPU 초록 2px glow + MEM 파랑 1.5px, 우측 스윕 엣지) → 트래픽 워터폴(초당 행, 스파이크 노랑) → 활성 연결 목록(RTT/버퍼).
- 폴링은 기존 계약(표시 중에만) 유지, 푸터에 명시.

### 4.7 Remote (workbench/RemotePanel.tsx + SshForwardSettings)
- 상단 토폴로지 다이어그램: PC(글로우 모니터 아이콘) ⇄ 점선 애니메이션 없는 대시 링크(wss 라벨+RTT) ⇄ 기기. 하단 미러 대상/입력 권한/해제.
- 2칸 그리드: **[QR 페어링] 액션 카드**(클릭=전용 모달) + [원격 데스크톱 호스트 상태].
- 페어링 기기 목록 + SSH 터널 행(포워드 포트 모노 + 토글).
- 평문 ws:// 경고 스트립(호박색 대시 보더) 유지.
- **QR 페어링 모달 (신규)**: 480px, 초록 탑바, 170px QR + 코드(24px, letter-spacing .22em, glow) + 유효시간 카운트다운/진행바 + 절차 안내. 코드 1회용 명시. 기존 페어링 IPC 그대로, UI만 모달화.

### 4.8 OpenClaw (OpenClawPanel.tsx / OpenClawChatPanel.tsx)
- **사이드바 = 콘솔**: 게이트웨이 카드(주소/uptime/중지) + 지표 3칸(채널/오늘 메시지/대기 작업) + 채널 목록 + 로그 테일 + [💬 채팅을 페인으로 열기][대시보드 ↗].
- **채팅 = Dockview 일반 패널** (WorkspaceTab과 동일 계약): 타이틀바 `🦞 OpenClaw — 채팅` + 채널 메타 + 승인 배지. 드래그/분할/크기/레이아웃 저장 전부 기존 Dockview 동작 그대로. 프로토타입의 "우측 자동 도킹"은 기본 배치 제안일 뿐.
- 말풍선: 수신(파랑 6% 배경, 좌측) / 발신(초록 6%, 우측) / 승인 카드(노랑, 인라인 승인·거부 = Agent Hub와 동일 디스패치) / 타이핑 3점.
- 컴포저가 채팅 페인 포커스 시 채팅 전송으로 라우팅 (선택 구현 — 페인 자체 입력이 1차).
- 기존 WebContentsView 임베드 제약(§4.4 occlusion 규칙) 유지.

### 4.9 다이얼로그 & 토스트 (ui/Dialog.tsx, ui/Toast.tsx, TerminalPasteWarningDialog / RiskyCloseDialog)
- 공통: 480px, radius 12px, 위험도 4px 탑바(경고=노랑 그라디언트, 위험=빨강) + 글로우, ezmodal 180ms.
- 페이스트 경고: 아이콘 칸 + 제목/부제("내용은 표시·기록되지 않습니다") + 통계 3칸(줄/크기/멀티라인) + [취소(기본 포커스, 글로우 링)][붙여넣기]. 기존 alertdialog 시맨틱/포커스 복원 유지.
- 위험 종료: 실행중 작업 리스트 박스 + [취소(포커스)][백그라운드 유지][강제 종료(빨강)].
- 토스트: 우하단 300px 스택, 종류별 보더 색, 제목+서브+✕(+선택 액션 버튼), 4.2s.

### 4.10 탐색기 (FileExplorerPanel.tsx) — 신규 요구
- 상단 **경로 바**: [↰ 상위] 버튼 + 브레드크럼 세그먼트(클릭=해당 깊이로 이동, 현재=밝게) + 아래 풀패스 한 줄(모노 10px, ellipsis).
- 목록: `..` 행(루트 제외) + 📁 폴더 → 파일 순, 변경 태그(+18 −6 / new).
- 워크스페이스 루트 밖 상위 탐색은 기존 파일서비스 권한 범위 내에서.

### 4.11 부팅 시퀀스 (main.tsx 마운트 오버레이, 신규)
- §3 모션 표 참조. 로그 문구: PTY 브리지 → 테마/FX → 에이전트 커넥터 → 게이트웨이 → 세션 복원 n/n.
- 설정 Appearance에 토글 (`부팅 인트로`), reduced-motion 시 자동 스킵. 첫 페인트 블로킹 금지 (오버레이로 얹기).

## 5. 구현 순서 (권장 PR 단위)

1. 토큰 확장 + CRT 오버레이 정리 (scanline/rollbar/vignette 컴포넌트화, FX 슬라이더 연동)
2. 헤더+레일+사이드바 셸 리스킨 (4.1–4.2)
3. Dockview 카드 테마 + 부유 컴포저 (4.3)
4. Command Center 리스킨 (4.4)
5. Agent Hub / Monitor / Remote(+QR 모달) 패널 (4.5–4.7)
6. OpenClaw 콘솔 + 채팅 Dockview 패널 (4.8)
7. 다이얼로그/토스트 (4.9)
8. 탐색기 경로 바 (4.10)
9. 부팅 시퀀스 (4.11) — 마지막, 순수 가산

## 6. QA 게이트

- 기존 e2e 전부 그린: workbench-shell · palette · tabs · splits · drag-layout · layout-persistence · settings · theme-effects-font · openclaw-panel/chat/visibility · status-panel · remote-toggle · ssh · file-explorer · crash-banner · ime-input.
- 뷰포트: 800×600 / 1024×720 / 1200×800 / 1440×900 (+1920×1080 시각 기준) — 가로 스크롤 금지.
- KO/EN 스위치에서 잘림 없음, reduced-motion에서 이동 이펙트 0.
- 대비: muted 텍스트도 4.5:1 이상 (기존 theme-contrast.ts 검사 통과).

## 7. 스크린샷 인덱스 (01~14-shot.png)

01 부팅 시퀀스 · 02 홈(셸+에이전트 허브) · 03 Command Center · 04 Monitor · 05 Remote · 06 QR 페어링 모달 · 07 QR 스캔 감지 · 08 OpenClaw 콘솔 · 09 채팅 페인 도킹 · 10 페이스트 경고 · 11 위험 종료 다이얼로그(직전 상태 포함) · 12 설정 · 13 EN 모드 · 14 탐색기 브레드크럼(EN)

## 8. 프로토타입 단순화 주의 (구현 시 실제 방식 사용)

- 레이아웃: 프로토타입=고정 프리셋 3종 / 실제=Dockview 자유 배치 유지, 프리셋은 단축.
- 터미널 출력=시뮬레이션 배열 / 실제=xterm 렌더러 (터미널 내부 스타일 변경 금지, 카드 크롬만).
- QR/페어링/채팅 응답=시뮬레이션 / 실제=기존 IPC·게이트웨이.
- 아이콘: 프로토타입=이모지 / 실제=**기존 lucide 아이콘 유지** (FolderTree/Bot/Activity/RadioTower/Wrench/Settings…).
