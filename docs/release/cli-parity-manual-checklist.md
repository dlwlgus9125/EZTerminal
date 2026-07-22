# CLI 패리티 — 수동 검증 체크리스트 (AC-1/AC-2/AC-3/AC-4/AC-10)

> 플랜 `.omc/plans/cli-parity-auto-pty.md` M5. **왜 수동인가**: `claude`/`codex`는 실행에
> 로그인 인증이 필요해 CI에서 자동화할 수 없다. AC-1/AC-2의 "기계 경로"(PATHEXT resolve →
> M1 배치 PTY spawn → M3 xterm 업그레이드)는 이미 `e2e/adaptive-render.spec.ts`의
> ink풍 `.cmd` shim 픽스처로 상시 회귀 검증된다 — 이 문서는 그 위에 실제 바이너리로만
> 확인 가능한 나머지(인증, 실 TUI 조작, 종료)를 다룬다. 릴리스마다 1회.

## 사전 준비

- [ ] `claude` CLI와 `codex` CLI가 로컬 PATH에 설치되어 있고 각각 최소 1회 로그인 완료
- [ ] `pnpm package` 최신 빌드 (`.vite/build/` 가 이번 세션의 소스를 반영하는지 확인 —
      `e2e/global-setup.ts`는 산출물이 **없을 때만** 빌드하므로 오래된 빌드로 착각하지 말 것)

## AC-1: `claude` sigil-free 기동

1. [ ] EZTerminal에서 `claude` 입력 (sigil `!` 없이) → Run
2. [ ] PTY 블록이 생성되고 claude의 실제 TUI(ink)가 xterm 블록으로 렌더됨 (plain 상태로
       머물지 않음 — 머무르면 AC-1 회귀, 즉시 에스컬레이션)
3. [ ] 로그인/인증 플로우가 정상 진행됨 (이미 로그인된 세션이면 스킵되는지도 확인)
4. [ ] 프롬프트에 실제 질의 입력 → 응답 스트리밍이 화면에 반영됨
5. [ ] Cancel 버튼으로 종료 → 프로세스가 실제로 죽는지 확인 (작업 관리자에서 claude 관련
       프로세스 잔류 없음)

## AC-2: `codex` sigil-free 기동

1. [ ] EZTerminal에서 `codex` 입력 (sigil 없이) → Run
2. [ ] PTY 블록이 xterm으로 업그레이드됨 (ratatui TUI 정상 렌더)
3. [ ] **OSC 10/11 컬러 쿼리 확인** (M0b 게이트 노트): codex가 시작 직후 전경/배경색을
       쿼리한다 — 응답 대기로 멈추거나 눈에 띄게 렌더가 깨지지 않는지 확인 (xterm 마운트가
       쿼리에 응답하는지가 관건)
4. [ ] 로그인/인증 플로우 정상 진행
5. [ ] 실제 질의 → 응답 스트리밍 확인
6. [ ] `Esc`로 현재 작업만 중단되고 Codex 세션은 유지되는지 확인
7. [ ] 선택 영역이 없을 때 `Ctrl+C`와 `Ctrl+D`가 Codex에 전달되지 않고 세션이 유지되는지 확인
8. [ ] 텍스트를 선택한 뒤 `Ctrl+C`로 Windows 클립보드에 복사되는지 확인
9. [ ] 이미지를 복사한 뒤 `Ctrl+V` → Codex가 자체 이미지 첨부로 처리하는지 확인(EZTerminal은
       임시 파일이나 경로를 만들지 않고 원시 `Ctrl+V`를 Codex에 전달함)
10. [ ] 이미지와 텍스트가 함께 있는 클립보드에서 `Ctrl+Shift+V` → 텍스트만 붙는지 확인
11. [ ] `/exit` 또는 `/quit`로 정상 종료되는지 확인
12. [ ] 다시 실행한 뒤 **Force stop(강제 종료)** 버튼으로 종료 → 프로세스 잔류 없음

## AC-3: python REPL (M0a 1회 확인, 상시 자동 없음)

`node` REPL은 `e2e/pty.spec.ts`의 AC-3 케이스가 상시 자동 회귀로 커버한다(빌드에 항상 존재하는
런타임이라 픽스처가 필요 없음). `python`은 이 머신에 상시 설치를 전제할 수 없어 자동 e2e 대상이
아니다 — M0a 실측 스파이크(`.omc/research/pty-signal-measurements.md`)에서 1회 확인됨: 고신뢰
TUI 신호 미방출, plain 렌더 유지, 최소 키셋 입력으로 정상 평가/종료. 릴리스마다 재확인:

- [ ] EZTerminal에서 `python` 입력(sigil 없이) → Run → PLAIN 렌더로 프롬프트(`>>>`) 표시
- [ ] `21 + 21` 입력 → Enter → `42` 출력 확인 (plain 모드 최소 키셋 입력 왕복)
- [ ] `exit()` 입력 → Enter → 블록 상태 `done`(cancelled 아님)

## AC-4: git commit / push (실 에디터·자격증명 프롬프트)

`e2e/git-flow.spec.ts`가 `$GIT_EDITOR`를 트리거 픽스처로 지정한 자동 `git commit` 왕복을
상시 검증한다(에디터가 실제로 기동되고 커밋이 완성되는지까지 — 정적 출력이 아니라 자식 프로세스
대기를 증명). 아래는 그 위에서 **실제** 에디터/네트워크 자격증명 UX만 다루는 수동 파트:

1. [ ] 로컬 리포에서 `git config core.editor`를 지우고(또는 `$env.GIT_EDITOR` 미설정) 바로
       `git commit`(메시지 없이) 실행 → 시스템 기본 에디터(예: notepad, vim)가 실제로 열리고
       편집 가능한지 확인 — `e2e/git-flow.spec.ts`는 트리거 픽스처라 실 에디터 TUI 자체는
       커버하지 않음
2. [ ] 원격 저장소(자격증명 필요한 HTTPS 또는 SSH)에 `git push` → 자격증명 프롬프트(비밀번호/
       패스프레이즈)가 PTY plain 입력으로 타이핑 가능한지 확인 — 라인 지향 프롬프트라 M3의
       plain 입력 배선(B-R4) 대상; `e2e/adaptive-render.spec.ts`의 line-prompt 케이스가 이
       입력 경로 자체는 커버하지만 실 git push 자격증명 화면은 수동 확인 필요
3. [ ] push 완료 후 블록 상태 `done`, 원격에 커밋 반영 확인

## `!` 강제 xterm (AC-7 실바이너리 확인)

- [ ] `!claude` — sigil 없이도 이미 auto-PTY(M2)이므로 동작은 동일해야 함; 렌더가 시작부터
      xterm인지 확인 (forceXterm은 업그레이드 감지를 기다리지 않고 즉시 xterm으로 시작)

## 알려진 제약 (범위 밖, 착각 방지용 기록)

- [ ] **claude 대화 기록 위로 스크롤 불가 — 원인 규명 및 해소 완료 (2026-07-03)**. 이전
      버전의 이 항목은 "EZTerminal 버그가 아니다/현재 아키텍처에서 지원 안 됨"으로 기록돼
      있었으나, 근본 원인이 **이 머신에 설치된 구형 시스템 ConPTY**(Windows 10 19045,
      2019~2021년대 conhost 빌드)의 실제 결함으로 확정되었고 이제 해소되었다: claude(ink)의
      렌더러가 절대좌표로 매 프레임을 다시 그리는 동안, 화면 밖으로 밀려난 이전 턴의 바이트를
      OS ConPTY 자체가 재합성 과정에서 누락시킴(30초 raw 캡처에서 긴 응답의 앞부분 확인 —
      `.omc/research/pty-signal-measurements.md` §9). **해소**: node-pty가 자체 번들
      `conpty.dll`/`OpenConsole.exe`(최신 빌드)를 쓰도록 하는 `useConptyDll:true` 옵션을
      `src/interpreter/external/pty-runner.ts`에서 채택 — 동일한 결정적 재현 시나리오(실제
      claude 80줄 응답)를 Electron+xterm.js 실 UI로 재검증한 결과, 휠 스크롤로 대화 시작
      프롬프트까지 전체 이력이 완전히 복구됨을 확인(이전엔 스크롤 20틱으로도 전혀 회복 안 됨).
      EZTerminal의 휠/스크롤백 배선 자체가 정상이었다는 기존 결론(합성 픽스처 회귀 잠금:
      `tui-scrollback.spec.ts` 2건)은 그대로 유효 — 문제는 배선이 아니라 OS ConPTY 쪽이었다.
      **잔여 제약**: `useConptyDll`은 Windows 전용 개념(macOS/Linux는 ConPTY가 없어 해당 없음)
      이라 이 결함·해소 모두 Windows 전용이다. 부수적으로, 번들 백엔드가 세션마다 무조건
      방출하는 프리앰블에 `?1004h`가 포함되어 TUI 감지기를 오탐시켰던 것도 감지기에서
      `?1004h`만 제외해 해소함(`src/interpreter/pty-session.ts`, 실제 신호 손실 없음 — claude/
      codex는 `?2004h`로 별도 포착). **여전히 스코프 밖인 것**: byte-stream(외부 명령 출력)은
      구조화 row로 변환되지 않아 `byte streams cannot be consumed as rows` EvalError로 즉시
      실패한다(`src/interpreter/core/value.ts` `toRowIterable`) — 이 플랜의 불변식 #6("빌트인·
      구조화 파이프라인 아키텍처 불변")에 따라 여전히 스코프 밖이며 회귀가 아니다. `git log`
      **단독**(파이프 없이)은 AC-4로 `e2e/pty.spec.ts`가 자동 커버한다.

- [ ] **`useConptyDll:true` 채택이 노출한 별도 결함 — Cancel이 인터프리터를 크래시시켰고,
      taskkill 우회로 해소됨 (2026-07-03)**. 위 스크롤백 해소 직후 발견: 실행 중인 PTY에서
      Cancel을 누르면(`pty.kill()` 경로) 인터프리터 utilityProcess 전체가 네이티브 힙 손상으로
      죽었다(Windows 종료 코드 `3221226356` = `0xC0000374` = `STATUS_HEAP_CORRUPTION`, 100%
      재현). 죽은 프로세스는 아무 것도 emit할 수 없으니 UI에는 그냥 "running" 상태가 영원히
      멈춘 것처럼만 보였다 — 실제로는 크래시. `node_modules/node-pty/lib/windowsPtyAgent.js`의
      kill() 구현을 직접 읽어 원인 확정: `useConptyDll:true` 경로는 `this._inSocket.destroy()`
      (동기 핸들 파괴)를 native kill() 호출 직전에 실행하는데, 이게 이중 해제(double-free) 형태의
      시퀀스였다. 자연 종료(프로그램이 스스로 exit)는 이 경로를 타지 않아 안전 — 실제로 자연
      종료하는 모든 테스트는 `useConptyDll:true`에서 그대로 통과했다. **해소**: Windows에서
      `pty.kill()`을 직접 호출하는 대신 자식 프로세스를 외부에서 `taskkill /T /F /PID <pid>`로
      트리째 종료(`src/interpreter/external/pty-runner.ts`의 `KillTreeFn`/`defaultKillTree`,
      `process-runner.ts`의 기존 `killChild` 관례와 동일 패턴) — 외부 종료는 node-pty의 안전한
      자연-종료 경로(`onExit`)를 타게 된다. `onExit`이 5초 내 오지 않으면 최후 수단으로 기존
      `proc.kill()`을 호출(이미 크래시하던 경로라 잃을 것이 없음). M1 배치 shim(`!fixture.cmd`)의
      cmd.exe→node.exe 손자 프로세스까지 `/T`로 정리됨을 e2e로 확인. 크래시가 실행 중인
      utilityProcess **전체**를 죽이므로(같은 프로세스의 다른 탭/세션도 함께 죽는다), 이 우회는
      스크롤백 해소만큼이나 필수였다.

## 결과 기록

- 실행일 / 실행자 / claude·codex 버전 / 통과 여부를 아래에 남긴다.

| 날짜 | 실행자 | claude 버전 | codex 버전 | AC-1 | AC-2 | AC-3(python) | AC-4(commit/push) | 비고 |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |
