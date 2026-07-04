# EZTerminal — Windows 코드서명 (B-M3)

> 인프라는 구축 완료(env-gated). **인증서 취득은 외부 의존 — 사용자 결정.**
> env 미설정 시 모든 빌드는 무서명으로 정상 동작한다 (기본값).

## 활성화 방법

```powershell
$env:WINDOWS_SIGN_CERT_FILE = 'C:\path\to\cert.pfx'   # 필수 — 없으면 서명 전체 skip
$env:WINDOWS_SIGN_CERT_PASSWORD = '...'               # pfx 비밀번호
pnpm make
```

- `forge.config.ts`의 `windowsSign`이 packager(EZTerminal.exe + dll/node) 및
  MakerSquirrel(`EZTerminal-Setup.exe`)에 동일 적용된다.
- `signtool.exe`는 `@electron/windows-sign`이 vendored — Windows SDK 불필요.
- 타임스탬프 서버 기본값: `http://timestamp.digicert.com` (오버라이드:
  `WINDOWS_TIMESTAMP_SERVER`는 라이브러리 기본 env 지원).
- CI(GitHub Actions)에서는 두 env를 repository secrets로 설정하면 release.yml(B-M2)이 그대로 서명한다.
  pfx 자체는 base64 secret → 임시 파일 복원 패턴 권장.

## 인증서 옵션 (취득 시 참고)

| 옵션 | 비용/절차 | SmartScreen 평판 |
|---|---|---|
| **Azure Trusted Signing** (권고) | 구독제, 개인/조직 검증 | MS 관리 인증서 — 평판 축적 유리 |
| OV 코드서명 인증서 (Sectigo/DigiCert 등) | 연 단위 구매, USB 토큰(2023+ 의무) | 다운로드 수 축적까지 경고 지속 |
| EV 인증서 | 고가, 하드웨어 토큰 | 즉시 평판 (SmartScreen 경고 최소) |
| 무서명 (현재) | 0원 | 설치 시 SmartScreen "알 수 없는 게시자" 경고 — 잠정 수용됨 |

- USB 토큰 기반 OV/EV는 CI 자동 서명이 어려움(토큰이 로컬 필요) → CI 서명까지 원하면
  Azure Trusted Signing이 현실적. 그 경우 `windowsSign.signWithParams`로 Trusted Signing
  dlib 파라미터를 넘기는 구성으로 확장한다(취득 후 이 문서 갱신).

## 검증 기록

- 무서명 경로(env 부재): `pnpm package` exit 0 — 기존과 동일 (2026-07-02 확인)
- 서명 경로: 자체서명 테스트 인증서(pfx)로 `pnpm package` → `Get-AuthenticodeSignature`가
  EZTerminal.exe에서 서명 확인. 자체서명이라 상태는 `UnknownError`(신뢰 체인 없음)지만
  signtool 실행·서명 삽입 경로가 동작함을 증명 (2026-07-02 확인)
