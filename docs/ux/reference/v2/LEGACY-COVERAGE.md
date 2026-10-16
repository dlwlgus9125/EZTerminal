# 기존 기능 보존 대응표

재배치가 기능 제거를 뜻하지 않는다. 각 항목의 기존 데이터·입력·수명 계약을 보존한다.

| 기존 기능 | Windows | Android | 유지 조건 |
| --- | --- | --- | --- |
| Structured shell·built-in·pipeline·결과 table | D28 | M09 | 기존 실행·입출력 의미 유지 |
| ConPTY·xterm·CLI·TUI·검색·Unicode | D28 | M09 | controller·출력·스크롤 보존 |
| 탭·분할·분리 창·layout preset | D28 | M09 | Desktop 자유 배치 유지; 모바일 세션 선택 |
| 기존 대화·원문 기록·자식 AI·직접 제어 | D18 | M04 | 세션 ID·대기열·permission 유지 |
| 기록·resume·archive·detach | D18 | M14 | 서로 다른 수명 동작 유지 |
| worktree·관리 merge·diff | D22 | M08 | 검증·revision·Desktop override 경계 유지 |
| 파일 탐색·안전한 preview·전송 | D29 | M10 | 접근·경로·전송 계약 유지 |
| Project Map | D30 | M10 | 기존 원본·후보·승인 구분; 모바일 관련 파일 진입 |
| SSH·호스트 키·포워딩 | D33 | M09 | 호스트 검증·late attach 제한 유지 |
| 모니터·프로세스·네트워크·패킷 | D31 | M12 | visible 수집과 명시적 capture |
| QR·pairing·VPN·기기 관리 | D32 | M01 | 1회용 5분 QR·기존 credential store |
| PC Control·모니터·터치·Bluetooth·IME | D32 | M11 | 명시적 시작·입력 release·수명 유지 |
| OpenClaw·gateway·chat·자동 실행 | D34 | M13 | 실행 상태와 관리 RPC 연결 분리 |
| 예약·heartbeat·CLI·MCP | D35 | M07 | 기존 명령 router와 수명 정책 유지 |
| Matrix·Dark·Light·High Contrast·custom | D39 | M15 | 기존 설정 보존; 신규 기본값만 변경 |
| 언어·자원 profile·tray·자동 시작 | D38 | M15 | 기기별 설정·명시적 앱 종료 유지 |
| 복사·붙여넣기·위험 종료 | D40 | M09 | 기존 focus·입력·검증 의미 유지 |
| 업데이트·진단·recovery·safe mode | D42 | M16 | 실제 실패 상태와 복구 경로 유지 |

Android의 표시는 대응 진입점을 의미한다. Desktop 전용 관리·호스팅 동작을 모바일에서 실행 가능하다고 표시하지 않는다.
