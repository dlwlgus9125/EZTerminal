# EZTerminal — Release Guide (B-M1/B-M2)

> 상태: B-M1 (앱 아이덴티티/인스톨러) 기준. B-M2(릴리스 플로우)·B-M3(서명)·B-M4(자동업데이트)가
> 진행되며 이 문서가 확장된다.

## 빌드 산출물

| 명령 | 산출물 | 용도 |
|---|---|---|
| `pnpm package` | `out/EZTerminal-win32-x64/EZTerminal.exe` | 패키지드 앱 (스모크 대상) |
| `pnpm make` | `out/make/squirrel.windows/x64/EZTerminal-Setup.exe` (+ `RELEASES`, `.nupkg`) | 배포용 인스톨러 |

- 앱/인스톨러 아이콘: `assets/icon.ico` — **플레이스홀더** (실물 아트로 교체 예정).
  재생성: `node scripts/generate-placeholder-icon.mjs`. 교체 시 같은 경로에 실물 .ico를 덮어쓰면 끝.
- exe 메타데이터(회사/제품/설명/저작권): `forge.config.ts` `packagerConfig.win32metadata`.
- `iconUrl`(제어판 프로그램 목록 아이콘)은 원격 URL 필수(Squirrel 제약) → GitHub 원격 생성 후 raw URL로 설정.

## 인스톨러 수동 스모크 체크리스트 (릴리스마다 1회)

Squirrel 인스톨러 UX는 Playwright로 검증 불가 — 아래 체크리스트가 가드다.

1. [ ] `pnpm make` exit 0, `EZTerminal-Setup.exe` 생성됨
2. [ ] Setup.exe 실행 → 스플래시 후 자동 설치, 앱 자동 실행됨
3. [ ] 시작 메뉴에 "EZTerminal" 바로가기 생성 + 아이콘 정상 표시
4. [ ] exe 속성 → 세부 정보: 제품명/설명/저작권/버전 표시 확인
5. [ ] 설치된 앱에서 기본 스모크: 명령 1개 실행(`ls`) + `!node --version` PTY 블록
6. [ ] 제어판/설정 → 앱 → EZTerminal 제거 → 시작 메뉴 바로가기 사라짐
7. [ ] (정책: 기본 보존) 제거 후 `%LOCALAPPDATA%\ezterminal`(Squirrel 앱 바이너리)은 삭제,
       `%APPDATA%\EZTerminal`(userData: 레이아웃/설정)은 **보존**되는지 확인 — 위치 문서화 목적

## 버저닝 (B-M2에서 확장)

- semver. `package.json` `version`이 단일 소스 — Squirrel `.nupkg`/`RELEASES`가 이를 따른다.
- 첫 릴리스 트레인: `0.1.0` (Stage 0 + A + B-M1~M3 완료 시점, 플랜 참조).
- 태그 `v*` push → `.github/workflows/release.yml`(B-M2에서 추가)이 draft GitHub Release 생성 예정.

## 외부 의존(사용자 결정 대기)

| 항목 | 상태 | 게이트 |
|---|---|---|
| GitHub 원격 (공개/비공개) | **없음 — 결정 필요** | B-M2 release.yml, B-M4 업데이트 피드, iconUrl |
| 코드서명 인증서 | 미보유 — env-gated 인프라만 (B-M3) | SmartScreen 평판 |
| 실물 아이콘 아트 | 플레이스홀더 사용 중 | 교체만 하면 됨 |
