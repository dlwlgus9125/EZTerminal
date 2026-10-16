EZTerminal 2.0 · R7.1 대화와 터미널 시안

https://ezterminal-conversation-r6.brawnycake257.chatgpt.site

프로젝트 목록에서 '새 대화' 옆의 '새 터미널'을 선택합니다.
같은 프로젝트의 작업 경로를 가진 PowerShell 터미널 시안이 새 탭으로 열립니다.
탭을 분할·드래그하거나 별도 창으로 옮겨도 대화와 터미널의 입력을 각각 유지합니다.
영역 메뉴에서는 '이 영역에 새 터미널', '새 터미널로 오른쪽 분할'도 가능합니다.
모바일에서는 왼쪽 프로젝트 목록을 열어 두 생성 버튼을 사용할 수 있습니다.

터미널에서 help, pwd, dir, git status를 입력하면 명시된 예시 출력을 보여 줍니다.
↑ ↓ 입력 기록, Ctrl L 화면 지우기, Enter 입력을 체험할 수 있습니다.
명령은 실제로 실행되지 않습니다. 실제 셸/PTY 연결은 제품 구현 단계입니다.
프로젝트 예시는 EZTerminal 하나입니다. 다중 프로젝트 격리는 아직 검증 범위가 아닙니다.

로컬 ZIP 실행: 압축 해제 후 dist 폴더에서
  python -m http.server 4317 --bind 127.0.0.1
실행 후 http://127.0.0.1:4317 로 접속합니다.

검증: pnpm e2e --config docs/ux/reference/v2-conversation-r7/terminal.playwright.config.cjs
11개 테스트 통과. 증거와 캡처는 evidence/terminal/ 에 있습니다.
