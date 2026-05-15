---
doc_type: product
authority: canonical
status: active
---

# Product Requirements Definition

## Vision

Windows 개발자를 위한 로컬 터미널 에뮬레이터. 터미널 작업과 시스템/네트워크 모니터링을 하나의 데스크톱 앱에 통합하여 컨텍스트 전환을 줄인다.

## Target User

- Windows 개발자 (10/11)
- 로컬 개발 환경에서 터미널 + 시스템 상태를 동시에 확인하려는 사용자
- PowerShell / cmd / WSL 셸 사용자

## Value Proposition

| 기존 도구 | EZTerminal 차별점 |
|-----------|------------------|
| Windows Terminal | 시스템/네트워크 모니터링 내장, 사이드 패널에서 즉시 확인 |
| Task Manager + Terminal | 단일 앱, 컨텍스트 전환 불필요 |
| btop/htop | Windows 네이티브, GUI 기반, 패킷 캡처 포함 |

## Scope

### 포함

- Electron 기반 터미널 에뮬레이터 (xterm.js + node-pty)
- 다중 탭 / 최대 4 페인 분할
- 시스템 모니터링: CPU, 메모리, 디스크, 프로세스, GPU
- 네트워크 모니터링: 트래픽 그래프, 패킷 캡처, hex dump, 연결 테이블
- 플로팅 패널 (멀티 모니터)
- 사용자 설정 (셸, 폰트, 모니터링 간격)

### 제외 (Non-goals)

- 원격 서버 연결 (SSH) — 향후 phase
- 모바일/iOS 지원
- 플러그인/확장 시스템
- 커스텀 VT 파서
- 외부 프로세스 의존 (btop, psnet 등)
- 블러/트랜지션/글로우 이펙트

## Success Criteria (v1.0)

- 앱 시작 → 셸 프롬프트 표시까지 3초 이내
- 키 입력 → PTY 도달 16ms 이내
- PTY 프로세스 누수 0건 (모든 시나리오)
- Npcap 미설치 환경에서 정상 동작 (패킷 캡처만 비활성)
- Biome 경고 0건, TypeScript strict 통과
