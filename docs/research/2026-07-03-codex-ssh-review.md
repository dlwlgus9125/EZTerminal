# Codex Gate — Stage E5 SSH 원격 세션 (E5-M0)

> Date: 2026-07-03 · Input: `docs/design/ssh-remote-design.md` (draft 515cc82)
> Runner: codex-companion (rollout 2026-07-03T00-20-39) — ssh2 미설치라 라이브러리 의미론
> 일부는 **NEEDS-INSTALL-VERIFY**로 표시(추측 금지 지침 준수).
> **Verdict: REVISE — 4 blockers.** 방향 타당; 실행 심·어댑터 의미론·패키징 정책·검증 상한 보강.

## Blockers → Resolution

**B1. pre-schema 프롬프트의 실행 심 부재.** `PtyStreamData.spawn`은 동기 반환이고
`runPtySession`은 spawn 직후 `schema{pty}`를 방출 — auth/TOFU 같은 async 단계가 낄 곳이 없음.
→ **ssh-connect는 PtyStreamData가 아니라 전용 `SshStreamData` + `runSshSession` 러너**
(runScriptSession 선례). 러너가 프롬프트/known-host 요청을 소유하고, **auth+TOFU+shell
channel ready 이후에만 schema 방출**. 모든 pre-spawn 대기는 AbortSignal+타임아웃과 race.

**B2. Channel↔PtyHandle 표가 ssh2 의미론 과단순화.** shell 채널의 `exit` 이벤트는 신뢰
불가(비발화 가능), `close`가 exit 인자 수신; stderr 병합은 PTY shell에서 부적절(PTY는 이미
병합); pause/resume의 SSH window 전파는 미검증.
→ **어댑터는 close/client-close/error에서 one-shot `onExit(정규화 코드)`** (exit는 보조).
PTY shell에서 stderr 스트림 별도 구독 금지. **pause→SSH window 동결은 인스톨 후
hermetic firehose 테스트로 실증**(vitest에서 ssh2 Server+Client in-process — Electron 불요).

**B3. 패키징 정책 미확정 — ssh2 자체 install.js가 번들 `sshcrypto.node` 빌드 시도.**
`pnpm.overrides`는 빌드 차단 메커니즘이 아님; 현 packageAfterPrune/externals는 node-pty 전용.
→ **확정: Option B(externalize+copy).** ssh2를 `onlyBuiltDependencies`에 **추가하지 않음**
(pnpm이 install 스크립트 차단 → sshcrypto.node 부재 → pure-JS 경로 — 이것이 의도).
`vite.interpreter.config.ts` externals에 ssh2 추가 + `packageAfterPrune`에 **재귀 prod-dep
워커**(ssh2의 package.json dependencies를 realpath로 따라 복사 — asn1 등 전이 포함).
패키지드 직결 테스트(B4)가 pure-JS 런타임까지 실증.

**B4. 검증 상한 부족.** → e2e: port 0·생성 호스트키·teardown 명시(게이트가 ssh2 Server
접근법 자체는 viable 확인). **패키지드: pty-packaged 선례의 직결 모듈 테스트 — 패키지드
ssh2를 require해 localhost Server와 실제 shell 왕복 + setWindow + close/error 경로.**

## 질문 답변 요지
① 프롬프트 타임아웃=러너 소유 타이머+signal race(60s), pre-spawn 단계 자체 취소 배선 필수
④ 패키지드 직결 모듈 검증이 가치 있음(위 B4) ⑤ setWindow(rows,cols,0,0) 일치; cancel은
channel.close+client.end로 충분하나 정상 종료는 client close/error 폴백 필요 ⑥ one-shot
가드는 원격 지연에 안전; cancel은 close를 안 기다림(기존 의미론); **백프레셔의 "원격까지
bound" 주장은 실증 전 금지** — pause가 SSH window adjust를 멈추는지 테스트로만 주장.

## 추가 발견 (폴드)
- Block.tsx의 프롬프트 분기는 **shape switch보다 먼저** 와야 함(pre-schema 상태).
- 새 frame/control마다 unit test(닫힌 union·default drop 확인).
- known_hosts 패턴 CONFIRMED. 단 **key rotation footgun**: mismatch 에러에
  **old/new 지문 + 파일 위치**를 포함해 사용자가 복구 가능하게.
