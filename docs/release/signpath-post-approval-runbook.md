# SignPath 승인 후 재개 런북

> 상태: SignPath Foundation 오픈 소스 코드 서명 신청 제출 완료, 심사 대기
>
> 마지막 확인: 2026-08-03
>
> 저장소: <https://github.com/dlwlgus9125/EZTerminal>

이 문서는 SignPath에서 메일이 도착했을 때 이전 대화 없이도 Windows 코드
서명 설정을 안전하게 재개하기 위한 단일 인수인계 문서다. 실제 저장소,
SignPath 대시보드와 GitHub 설정이 이 문서보다 우선한다.

## 메일이 오면 시작할 문장

새 작업 세션에서 다음과 같이 요청한다.

```text
docs/release/signpath-post-approval-runbook.md 기준으로 SignPath 승인 후 작업을
계속 진행해줘. 메일 유형은 승인/추가 질문/거절 중 하나야. API token과 초대
링크의 일회성 값은 가리고 메일 또는 대시보드 화면을 첨부할게.
```

API token, 비밀번호, 초대 토큰, 복구 코드는 채팅, 이 문서, 커밋, 셸 명령의
인수 또는 스크린샷에 넣지 않는다.

## 현재 완료 상태

- 사용자가 2026-08-03에 SignPath 신청서 제출을 완료했다고 확인했다.
- SignPath 준비 변경은
  [PR #4](https://github.com/dlwlgus9125/EZTerminal/pull/4)로 `main`에
  병합됐다. 병합 커밋은
  `04f6259c56cb19e98e04764e0426224a92f591d5`다.
- 신청 당시 저장소, 다운로드, 개인정보 처리방침, 보안 정책과 코드 서명
  정책 공개 링크는 HTTP 200으로 확인됐다.
- GitHub 저장소 설명과 관련 토픽을 설정했다.
- GitHub Environment `release`는 존재하며 Android 서명 설정을 보유한다.
- `release` Environment에는 아직 다음 SignPath 항목이 없다.

  - secret `SIGNPATH_API_TOKEN`
  - variable `SIGNPATH_ORGANIZATION_ID`
  - variable `SIGNPATH_PROJECT_SLUG`
  - variable `SIGNPATH_SIGNING_POLICY_SLUG`
  - variable `SIGNPATH_WINDOWS_PAYLOAD_CONFIGURATION_SLUG`
  - variable `SIGNPATH_WINDOWS_INSTALLER_CONFIGURATION_SLUG`

- `.github/workflows/release.yml`에는 심사 중 유지보수용 무서명 경로와 승인 후
  두 단계 SignPath 경로가 모두 구현돼 있다. `release/version.json`의 명시적
  모드와 여섯 GitHub 설정의 완전성이 일치해야 한다. 일부 설정이나 SignPath
  실패를 무서명으로 우회하지 않는다.
- 현재 버전 계약은 `1.0.28`, Android versionCode `49`, protocol `7`,
  validation profile `functional-hotfix`, Windows signing mode `unsigned`다.
  이 값은 재개 시 다시 확인한다.
- 기존 1.0.23 GitHub Release의 Windows 파일은 과거에 게시된 무서명
  자산이다. 승인 후 시험 산출물로 기존 자산을 조용히 교체하지 않는다.

현재 상태를 다시 확인하는 명령:

```powershell
git fetch origin main
git log -1 --oneline origin/main
gh secret list --env release --repo dlwlgus9125/EZTerminal
gh variable list --env release --repo dlwlgus9125/EZTerminal
```

목록 명령은 secret 이름과 수정 시각만 표시하며 secret 값은 표시하지 않는다.

## 메일 유형별 분기

### 승인 또는 조직 초대

아래의 "승인 후 일회성 설정"부터 진행한다. SignPath 조직 초대는 발송 후
14일 안에 수락해야 한다. 링크를 열기 전에 도메인이 SignPath의 공식
도메인인지 확인한다.

### 추가 정보 요청

추측하거나 기능을 숨기지 말고 메일 원문을 기준으로 답한다. 특히 다음
사실을 저장소 문서와 코드로 다시 확인해 설명한다.

- EZTerminal은 구조화 데이터와 블록 UI를 제공하는 Windows 터미널이다.
- 패킷 캡처는 선택적이고 사용자가 명시적으로 시작하는 로컬 기능이며,
  취약점 탐지나 공격 자동화 기능이 아니다.
- 원격 터미널/화면 제어는 기본 비활성화이고 사용자가 선택한 신뢰 VPN과
  명시적 승인 흐름을 전제로 한다.
- 프로젝트 운영자는 telemetry, 광고 또는 crash-reporting 서비스를
  운영하지 않는다.
- 개인정보, 보안과 서명 범위의 근거는 `PRIVACY.md`, `SECURITY.md`,
  `CODE_SIGNING_POLICY.md`에 있다.

답변을 보내기 전 사용자가 최종 문안을 확인한다.

### 거절

- 명시적인 `unsigned` 유지보수 정책을 그대로 두고 SHA-256 검증, 사용자 직접
  다운로드·실행 및 앱 내부 재확인을 유지한다.
- 임의 인증서, Microsoft Store 또는 다른 배포 경로로 자동 전환하지 않는다.
- 거절 사유를 보존한다. SignPath 재신청, Microsoft Store 또는 다른 인증서로
  바꾸려면 별도의 사용자 승인 아래 정책과 배포 전략을 다시 설계한다.

## 승인 후 일회성 설정

### 1. 계정과 프로젝트 확인

- SignPath 조직 초대를 수락하고 SignPath와 GitHub 양쪽에 MFA를 활성화한다.
- SignPath 프로젝트의 repository URL이 정확히
  `https://github.com/dlwlgus9125/EZTerminal`인지 확인한다.
- SignPath가 이미 만든 organization, project, signing policy 또는 artifact
  configuration을 중복 생성하지 않는다. 승인 메일과 대시보드의 기존 구성을
  먼저 확인한다.
- 사람 계정은 승인자 역할을, 전용 CI 사용자는 submitter 역할을 갖게 한다.
  Trusted Build System 검증을 사용하는 정책에서는 interactive user를
  submitter로 지정하지 않는다.
- CI 사용자 API token은 생성 시 한 번만 표시될 수 있으므로 즉시 GitHub
  secret으로 저장한다. token 자체는 이 문서에 기록하지 않는다.

### 2. GitHub trusted build 연결

- SignPath organization에 predefined Trusted Build System `GitHub.com`이
  있는지 확인한다.
- 해당 trusted build system을 EZTerminal SignPath project에 연결한다.
- source/build policy 확인을 사용하도록 승인 설정이 제공되면 SignPath
  GitHub App을 설치하고 `dlwlgus9125/EZTerminal` 접근을 허용한다.
- 허용 저장소, 기본 브랜치와 빌드 origin이 이 저장소의 GitHub-hosted
  `Release` workflow를 가리키는지 확인한다.
- Open Source Code Signing 요청으로 이어지는 모든 빌드 job은
  GitHub-hosted runner에서 실행돼야 한다. 현재 workflow는 이 조건에 맞게
  구성돼 있지만 재개 시 diff를 다시 확인한다.

### 3. signing policy 확인

- certificate/publisher는 정확히 `SignPath Foundation`이어야 한다.
- Authenticode와 RFC 3161 timestamping을 사용한다.
- release signing에 수동 승인을 활성화한다.
- CI 사용자는 제출만 할 수 있고 사람 승인자가 요청을 승인하게 한다.
- 이 저장소는 한 릴리스에서 payload와 최종 installer를 따로 요청하므로
  사람 승인자는 두 요청을 각각 검토하고 승인해야 한다.

### 4. artifact configuration 두 개 등록

다음 커밋된 XML을 SignPath project에 각각 import/upload한다.

| 용도 | 원본 파일 | 정확한 서명 대상 |
|---|---|---|
| Windows payload | `.signpath/windows-payload.xml` | `EZTerminal.exe`, `ezterminal-remote-host.exe`, `Uninstall EZTerminal.exe` |
| Windows installer | `.signpath/windows-installer.xml` | `EZTerminal-Setup.exe` |

두 configuration 모두 필수 parameter `version`을 사용하며 모든 PE 파일의
ProductName은 `EZTerminal`, ProductVersion은 전달된 `version`과 일치해야
한다. configuration을 저장한 뒤 각각의 slug를 기록하되 임의로 추측하지
않는다.

### 5. 승인 메일/대시보드에서 확보할 값

| SignPath 값 | GitHub `release` Environment 대상 |
|---|---|
| Organization ID | variable `SIGNPATH_ORGANIZATION_ID` |
| Project slug | variable `SIGNPATH_PROJECT_SLUG` |
| Release signing policy slug | variable `SIGNPATH_SIGNING_POLICY_SLUG` |
| Payload artifact configuration slug | variable `SIGNPATH_WINDOWS_PAYLOAD_CONFIGURATION_SLUG` |
| Installer artifact configuration slug | variable `SIGNPATH_WINDOWS_INSTALLER_CONFIGURATION_SLUG` |
| CI submitter API token | secret `SIGNPATH_API_TOKEN` |

ID와 slug는 secret이 아니지만 SignPath 대시보드의 실제 값을 복사한다. API
token은 화면 공유에서 가리고 아래 interactive 명령으로만 입력한다.

### 6. GitHub Environment에 등록

아래 placeholder를 실제 값으로 바꿔 실행한다.

```powershell
gh variable set SIGNPATH_ORGANIZATION_ID `
  --env release --repo dlwlgus9125/EZTerminal `
  --body "<organization-id>"

gh variable set SIGNPATH_PROJECT_SLUG `
  --env release --repo dlwlgus9125/EZTerminal `
  --body "<project-slug>"

gh variable set SIGNPATH_SIGNING_POLICY_SLUG `
  --env release --repo dlwlgus9125/EZTerminal `
  --body "<signing-policy-slug>"

gh variable set SIGNPATH_WINDOWS_PAYLOAD_CONFIGURATION_SLUG `
  --env release --repo dlwlgus9125/EZTerminal `
  --body "<payload-artifact-configuration-slug>"

gh variable set SIGNPATH_WINDOWS_INSTALLER_CONFIGURATION_SLUG `
  --env release --repo dlwlgus9125/EZTerminal `
  --body "<installer-artifact-configuration-slug>"

# 값을 명령 인수나 shell history에 넣지 않는다. 이 명령의 interactive
# 입력으로 API token을 붙여넣는다.
gh secret set SIGNPATH_API_TOKEN `
  --env release --repo dlwlgus9125/EZTerminal
```

등록 후 이름과 non-secret variable 값만 확인한다.

```powershell
gh secret list --env release --repo dlwlgus9125/EZTerminal
gh variable list --env release --repo dlwlgus9125/EZTerminal
```

`SIGNPATH_API_TOKEN`을 출력하거나 API 호출로 복호화하려고 시도하지 않는다.

### 7. 저장소 서명 모드를 `signpath`로 전환

여섯 GitHub 설정을 모두 확인한 뒤 `release/version.json`의 다음 필드를
검토된 커밋에서 변경해 `main`에 병합한다.

```json
"windowsSigningMode": "signpath"
```

이 전환은 자동 복귀하지 않는다. `signpath` 상태에서 설정이 하나라도 없거나
서명 요청이 실패하면 release workflow는 중단되며 무서명 파일을 게시하지
않는다. 반대로 `unsigned` 상태에서 SignPath 설정이 하나라도 감지돼도 잘못된
전환 순서로 보고 중단된다.

## 첫 서명 통합 시험

### 실행 전 정지 조건

- 승인 상태, project/status, trusted build link, policy, 두 artifact
  configuration과 여섯 GitHub 설정 중 하나라도 불명확하면 실행하지 않는다.
- 먼저 `main`의 버전 계약, release notes와 exact SHA 상태를 확인하고
  `windowsSigningMode`가 `signpath`인지 확인한다.
- 기존 tag를 이동하거나 같은 tag를 다시 만들지 않는다.
- `workflow_dispatch`는 게시 job을 실행하지 않고 검토 가능한 artifact만
  만든다. 그래도 SignPath 서명 요청 두 건이 생성되므로 사용자가 시험
  실행을 명시적으로 승인한 뒤 시작한다.
- 이 런북은 성능 측정 승인이 아니다. 사용자가 별도로 "성능 측정"을
  요청하지 않는 한 `pnpm e2e:performance`,
  `e2e/release-performance.spec.ts`,
  `EZTERMINAL_RUN_RELEASE_PERFORMANCE=1` 또는
  `-RunPerformanceMeasurement`를 실행하지 않는다.

기본 preflight:

```powershell
git fetch origin main
git status --short
git log -1 --oneline origin/main
pnpm verify:version
(Get-Content release/version.json -Raw | ConvertFrom-Json).windowsSigningMode
```

작업 트리가 깨끗하고 사용자가 non-publishing 시험을 승인하면 다음을
실행한다.

```powershell
gh workflow run Release `
  --ref main `
  --repo dlwlgus9125/EZTerminal
```

실행 직후 GitHub Actions와 SignPath 대시보드를 함께 감시한다. workflow의
각 SignPath 대기 제한은 7,200초이므로 두 번의 수동 승인을 2시간 안에
처리할 수 있을 때만 시작한다.

1. 첫 요청에서 ZIP의 정확한 파일이 `EZTerminal.exe`,
   `ezterminal-remote-host.exe`, `Uninstall EZTerminal.exe` 세 개인지,
   source/build origin과 version이 맞는지 확인하고 승인한다.
2. workflow가 signed payload를 검증하고 NSIS installer를 다시 만들 때까지
   기다린다.
3. 두 번째 요청에서 정확한 파일이 `EZTerminal-Setup.exe` 하나인지,
   source/build origin과 version이 맞는지 확인하고 승인한다.
4. GitHub workflow가 끝날 때까지 감시한다. 실패하면 tag나 새 release로
   우회하지 말고 실패한 request ID와 정확한 red step을 보존해 진단한다.

## 시험 완료 판정

다음을 모두 직접 확인해야 `SIGNPATH INTEGRATION READY`다.

- non-publishing `workflow_dispatch` run의 모든 필수 job이 PASS다.
- SignPath payload와 installer 요청이 모두 `Completed`다.
- manifest에 서로 다른 두 SignPath signing-request ID가 기록됐다.
- `EZTerminal.exe`, `ezterminal-remote-host.exe`,
  `Uninstall EZTerminal.exe`, `EZTerminal-Setup.exe` 네 파일의 Authenticode
  상태가 `Valid`다.
- 네 파일의 publisher가 정확히 `SignPath Foundation`이다.
- 네 파일에 timestamp가 있고 ProductName/ProductVersion, 파일명, 개수와
  SHA-256 검사가 모두 통과했다.
- 설치 후 설치된 세 first-party executable을 다시 검사하고 제거하는 smoke
  단계가 PASS다.
- workflow_dispatch 시험으로 GitHub Release나 tag가 새로 생성되지 않았다.

서명이 Valid여도 새 파일 또는 인증서의 Microsoft Defender SmartScreen
평판 경고가 즉시 사라진다고 보장하지 않는다.

## 시험 성공 후 실제 릴리스

첫 통합 시험 성공은 새 버전 게시 승인이 아니다. 다음 릴리스는 별도 작업으로
진행한다.

1. 사용자와 다음 버전, validation profile 및 릴리스 범위를 확정한다.
2. 버전 계약, Android versionCode, release notes와 validation policy를 같은
   커밋으로 맞춘다.
3. 해당 SHA에 요구되는 일반 release 검증과 승인 증거를 새로 만든다. 과거
   SHA의 local RC 값이나 artifact를 재사용하지 않는다.
4. `workflow_dispatch`로 exact-SHA signed artifact를 먼저 검토한다.
5. 동일 SHA에 `v<version>` tag를 만드는 행위와 draft GitHub Release 생성은
   사용자의 별도 게시 승인 후 수행한다.
6. 게시 후 GitHub 자산을 다시 내려받아 Authenticode, timestamp, publisher,
   manifest와 SHA256SUMS를 재검증한다.

## 공식 및 저장소 근거

- [SignPath Foundation conditions](https://signpath.org/terms.html)
- [SignPath user invitations, API tokens and roles](https://docs.signpath.io/users/)
- [SignPath project, signing policy and artifact configuration](https://docs.signpath.io/projects)
- [SignPath GitHub trusted build integration](https://docs.signpath.io/trusted-build-systems/github)
- `.github/workflows/release.yml`
- `.signpath/windows-payload.xml`
- `.signpath/windows-installer.xml`
- `docs/release/signpath-setup.md`
- `CODE_SIGNING_POLICY.md`
- `PRIVACY.md`
- `SECURITY.md`
