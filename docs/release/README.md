# EZTerminal — Release Guide

> 현재 배포 대상은 Windows Electron 앱과 Android Capacitor 원격 클라이언트다.
> Git 태그는 검증된 로컬 산출물을 만든 뒤 별도 승인으로 push한다.

## 빌드 산출물

| 명령 | 산출물 | 용도 |
|---|---|---|
| `pnpm package` | `out/EZTerminal-win32-x64/EZTerminal.exe` | 패키지드 앱 (스모크 대상) |
| `pnpm make` | `out/make/squirrel.windows/x64/EZTerminal-Setup.exe` (+ `RELEASES`, `.nupkg`) | 배포용 인스톨러 |
| `pnpm --dir mobile build` → `pnpm --dir mobile cap:sync` → `mobile/android/gradlew.bat -p mobile/android clean assembleRelease` | `mobile/android/app/build/outputs/apk/release/app-release.apk` | 내부 Android/Taildrop 배포 |

- 앱/인스톨러 아이콘: `assets/icon.ico` — `appicon.png` 기반 실물 아트.
  재생성: `node scripts/generate-app-icon.mjs`.
- exe 메타데이터(회사/제품/설명/저작권): `forge.config.ts` `packagerConfig.win32metadata`.
- Windows 인증서 환경변수가 없으면 인스톨러는 무서명이며 SmartScreen 경고가 표시될 수 있다.
- Android `release` 빌드는 현재 debug key로 서명된다. Taildrop/내부 업데이트용이며 Play Store용 서명이 아니다.

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

## 버저닝

- semver. Windows는 루트 `package.json`, 모바일은 `mobile/package.json`과
  `mobile/android/app/build.gradle`의 `versionName`을 같은 값으로 유지한다.
- Android `versionCode`는 모든 APK 빌드 릴리스마다 증가시킨다.
- 태그 `v*` push → `.github/workflows/release.yml`이 Windows 산출물을 검증하고 draft GitHub Release를 생성한다.
- 현재 release workflow는 APK를 만들거나 첨부하지 않으므로 Android 산출물은 별도 업로드한다.

## 외부 의존

| 항목 | 상태 | 게이트 |
|---|---|---|
| GitHub 원격 | 공개 저장소 연결됨 | 태그 push 시 draft release 생성 |
| Windows 코드서명 인증서 | 미보유 — env-gated 인프라만 | SmartScreen 평판 |
| Android 배포 서명 | debug key | 내부 Taildrop만 허용, 스토어 배포 전 교체 필요 |
