# Stage E5 — SSH 원격 세션 (Design, E5)

> Status: **✅ 구현 완료 (2026-07-03).** Codex REVISE(4 blockers) 전부 반영.
> Gate record: `docs/research/2026-07-03-codex-ssh-review.md`
> Date: 2026-07-03 · Baseline: f850394 (vitest 243 · e2e 40 · packaged 6) →
> **완료 시점: vitest 303 · e2e 44 · packaged 7 · audit 0**
> 사용자 확정(2026-07-03): PTY 전용 원격 · 자격증명=키파일 경로+비밀번호는 세션당 프롬프트
> (저장 안 함) · 호스트키=TOFU(최초 접속 지문 확인).

## 구현 노트 (2026-07-03)

§1의 "PtyHandle 어댑터 직접 재사용" 초안은 **게이트 B1에서 기각**되었다 — 실제 구현은
§7의 전용 러너 방향을 따른다(`src/interpreter/ssh-session.ts`의 `runSshSession` +
`src/interpreter/external/ssh-client.ts`의 어댑터; `PtyStreamData`는 반환하지 않음).
채널 오픈 **이후**에만 기존 PTY 백프레셔·렌더러 경로를 재사용한다 — §1의 표는 "채널
레벨 매핑"으로는 여전히 유효하지만 "PtyHandle을 곧바로 반환"하는 문장은 사실이 아니다.

빌드 중 발견한 시퀀싱 버그(설계에 없던 회귀, 수정함): 최초 구현은 `ssh2.Client.connect()`를
호출하기 **전에** 자격증명(비밀번호/패스프레이즈)을 프롬프트했다 — 그런데 호스트키
검증(`hostVerifier`)은 `connect()` **내부**, KEX 단계에서만 실행되므로, 결과적으로
자격증명 프롬프트가 TOFU 확인보다 먼저 뜨는 순서가 되어버렸다(§7의 "connect → hostVerify
→ auth" 명세와 정상 SSH 보안 UX 모두에 위배 — 호스트 신원 확인 전에 비밀번호를 요구하는
모양새). ssh2의 `authHandler` 미들웨어(`ConnectConfig.authHandler`)로 고쳤다: 자격증명
해석을 `connect()` 호출 시점이 아니라 authHandler 콜백(ssh2가 KEX/호스트 검증 완료 **후**
에만 호출)으로 미뤄, 프롬프트 순서가 항상 "호스트키 확인(필요 시) → 자격증명"이 되도록
보장한다. `external/ssh-client.ts`의 `SshConnectOptions`에서 `password`/`privateKey`/
`passphrase` 필드를 제거하고 `authHandler: SshAuthHandler`로 대체했다.

게이트 B2("pause→SSH window 동결 실증")는 `src/interpreter/external/
ssh-pause-backpressure.test.ts`에서 실제 ssh2 `Server`+`Client`(in-process, 프로덕션
어댑터 경유)로 확인 — pause() 후 수신 바이트가 완전히 멈추고 resume()으로 재개됨을
실측, NEEDS-INSTALL-VERIFY 해소.

## 0. 가치 명제 (왜 `!ssh`로 충분하지 않은가)

`!ssh user@host`는 **이미 동작한다**(시스템 OpenSSH + ConPTY). E5의 증분:
① 시스템 ssh 클라이언트 무의존(ssh2 라이브러리 내장) ② TOFU 호스트키 UX(앱 통제)
③ 자격증명 플로우(키파일/프롬프트 — 셸 밖 UI) ④ v2 원격 구조화 데이터의 연결 토대.
v1이 ①~③만 제공해도 `!ssh` 대비 정당한 이유: 원격 기능의 **앱 소유 제어 평면** 확보.

## 1. 핵심 설계: PtyHandle 어댑터 재사용 (신규 표면 최소화)

`ssh-connect user@host [--key <path>] [--port <n>]` 빌트인은 **기존 `PtyStreamData`를
반환**한다. spawn(cols, rows)가 ssh2 `Client`→shell `Channel`을 열고 이를 `PtyHandle`로
어댑트:

| PtyHandle | ssh2 매핑 |
|---|---|
| onData | channel.on('data') (+stderr 병합: channel.stderr.on('data')) |
| onExit | channel.on('close') → exit code |
| write | channel.write |
| resize | channel.setWindow(rows, cols, 0, 0) |
| pause/resume | channel.pause()/resume() (Node stream — **기존 바이트-ack 백프레셔가 무변경 동작**) |
| kill | channel.close() + client.end() (resume-then-kill 계약 준수) |

→ 렌더러 PtyBlock/xterm, runPtySession(one-shot 가드·cancelled), Stage C 백프레셔,
취소 경로 **전부 재사용**. 신규는 "연결 전 단계"(§2)뿐.

## 2. 연결 전 상호작용 (신규 프로토콜 표면 — 유일한 새 UI)

ssh 핸드셰이크는 channel(=PTY) 생성 **전**에 사용자 입력이 필요할 수 있다:
비밀번호/키 passphrase, TOFU 지문 확인. 기존 per-command 포트로 additive 프레임:

- interp→renderer `ssh-prompt { promptId, kind: 'password'|'passphrase'|'hostkey',
  message, fingerprint? }`
- renderer→interp control `ssh-prompt-response { promptId, value?: string,
  accept?: boolean }`
- BlockController: snapshot에 `prompt?: {...}` 추가(urgent 통지) → Block.tsx가
  schema 전 상태에서 인라인 프롬프트 카드 렌더(마스킹 입력 or 지문+수락/거부 버튼).
  응답/취소 시 프롬프트 해제. **비밀번호는 어디에도 저장·로그 금지** (프레임은 포트
  직결이라 main 미경유).
- 취소/타임아웃: 프롬프트 대기도 signal race (미응답 시 60s에 자체 실패? → 게이트 질문 ①).

## 3. known_hosts (TOFU 영속 — main 소유 규칙 준수)

- `userData/known_hosts.json` — 기존 스토어 패턴(버전드 엔벨로프·원자쓰기·격리)으로
  main의 KnownHostsStore. `Record<host:port, { keyType, fingerprintSha256 }>`.
- 인터프리터↔main additive 메시지: `known-host-check {requestId, host, keyType, fp}` →
  `known-host-verdict {requestId, verdict: 'match'|'mismatch'|'unknown'}` ·
  `known-host-add {host, keyType, fp}` (TOFU 수락 시).
- **mismatch = 하드 실패**(경고 무시 옵션 없음 — v1은 사용자가 항목 삭제로만 해제;
  파일 위치 문서화). unknown → §2 hostkey 프롬프트 → 수락 시 add.

## 4. ssh2 의존성/패키징

- `ssh2`(prod dep 신규). **optional native(cpu-features 등) 미설치** — pure-JS 경로.
  pnpm이 optional을 기본 설치하려 함 → `pnpm.overrides`/`neverBuiltDependencies`로 차단
  검토 (게이트 질문 ②).
- 인터프리터 번들에서 externalize(+`packageAfterPrune` 복사, node-pty 선례 — native 없음
  버전이라 asar.unpack 불요 추정, **게이트 질문 ③**: ssh2의 동적 require가 asar 안에서
  안전한가 → 불안하면 unpack 추가).

## 5. 검증

- **유닛:** PtyHandle 어댑터(fake Channel: data/stderr 병합·resize 매핑·resume-then-kill
  순서·close→exit one-shot) · 프롬프트 상태기계(응답/취소/중복 promptId) ·
  KnownHostsStore(TOFU add/match/mismatch/격리).
- **e2e (핵심 아이디어): ssh2의 `Server` 클래스로 테스트 내 localhost 서버** —
  hermetic (시스템 sshd 불요). 시나리오: ① password 인증 → 프롬프트 카드 → 입력 →
  원격 echo 셸에서 타이핑 라운드트립(xterm) ② TOFU: 최초 접속 지문 프롬프트 → 수락 →
  재접속 시 무프롬프트(known_hosts 영속, temp userData 재사용) ③ 지문 변경(서버 키 교체)
  → 하드 실패 ④ 취소: 프롬프트 대기 중 cancel → cancelled ⑤ 접속 후 방화벽 없는 로컬
  연결이므로 flaky 최소.
- **패키지드:** ssh2가 packaged exe에서 로드+로컬 서버 접속 1회(스크립트-호스트 선례의
  번들 존재 확인 + 가능하면 interpreter 경유 실연결 — UI 불가 제약 동일 → 게이트 질문 ④).

## 6. Out of scope (v1)

연결 프로필 저장/UI · ssh-agent · SFTP/포트포워딩 · 원격 구조화 빌트인(ls 등 — v2 리서치) ·
멀티홉/점프호스트 · 재접속/keepalive 정책(연결 끊김 = 세션 종료).

## 7. 게이트 반영 (REVISE 4블로커 — 빌드 요구사항)

1. **전용 러너 (B1):** `PtyStreamData` 재사용 **금지** — `SshStreamData`(kind:'ssh-stream',
   {host, port, user, keyPath?}) + `runSshSession(data, emit, signal, deps)` 러너
   (runScriptSession 선례). ExecutionSession에 라우팅 분기 1개. **schema{pty}는
   auth+TOFU+shell channel ready 이후에만 방출** — 그 전 단계에서 `ssh-prompt` 프레임으로
   비밀번호/passphrase/지문을 요청. **모든 pre-channel 대기 = race(signal, 60s 타임아웃,
   클라이언트 error)** — 미응답 60s면 자체 실패(에러 프레임).
2. **어댑터 의미론 (B2):** shell 채널의 `exit` 이벤트는 **보조** — one-shot
   `onExit(정규화 코드)`는 channel `close` / client `close|error`에서 발화(코드 없으면 -1).
   **shell PTY에서 `channel.stderr` 구독 금지**(PTY가 이미 병합; exec 전용 개념).
   channel ready 후에는 기존 PtyHandle 심으로 어댑트해 runPtySession-동형 로직 재사용하되
   러너 내부에서 (별도 runPtySession 호출 대신 자체 one-shot 가드 — pre/post 단계 통합).
   **pause→SSH window 동결의 실증 필수**: vitest에서 ssh2 Server+Client in-process
   firehose — pause 후 수신 동결/resume 후 재개 단언 (Electron 불요, NEEDS-INSTALL-VERIFY 해소).
3. **패키징 (B3, Option B 확정):** `pnpm add ssh2` + `pnpm add -D @types/ssh2` —
   **`onlyBuiltDependencies`에 ssh2/cpu-features 추가하지 않음**(install 스크립트 차단 →
   `sshcrypto.node` 미빌드 → pure-JS 경로가 곧 정책). `vite.interpreter.config.ts`
   externals += 'ssh2'. `packageAfterPrune`에 **재귀 prod-dep 복사기**: ssh2의
   package.json dependencies를 realpath로 따라가며 전이 포함 복사(asn1 등). `.node` 미배포
   → asar.unpack 불요.
4. **검증 (B4):** e2e — ssh2 `Server`(port 0, 생성 호스트키, server.close/채널 teardown
   명시, temp userData): ① password 프롬프트→입력→원격 echo 왕복 ② TOFU 수락→재접속
   무프롬프트(영속) ③ 서버 키 교체→**old/new 지문+파일 위치를 포함한** 하드 실패
   ④ 프롬프트 대기 중 취소→cancelled. **패키지드 — 직결 모듈 테스트**(pty-packaged 선례):
   패키지드 ssh2 require → localhost Server와 실제 shell 왕복 + setWindow + close 경로
   (pure-JS 런타임 실증 겸용).
5. **기타 폴드:** Block.tsx의 프롬프트 분기는 shape switch **앞**에 · 새 frame/control마다
   유닛테스트(닫힌 union) · known_hosts mismatch 에러에 old/new 지문 + `known_hosts.json`
   경로 포함(key rotation 복구 안내).
