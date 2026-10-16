# r4 근거와 의존성

[r3](../v2-agent-chat-r3/README.md)의 공통 대화 UI를 확장한 저장소 로컬 검토 자료입니다.
외부 제품의 현재 API 지원을 새로 검증했다고 주장하지 않습니다. 이전 provider 조사 시점과 자료는
[r1 SUPPORT](../v2-agent-chat-r1/SUPPORT.md)를 따르며 제품 구현에서는 설치된 provider로 다시 확인합니다.

색상/타입은 기존 [runtime token](../../../../src/renderer/styles/ui-tokens.css)의 복사본을 사용합니다.
`build.mjs`가 원본 hash와 source fingerprints를 기록합니다. Lucide 아이콘은 현재 설치된 lucide-react에서
생성하며 ISC/MIT 고지는 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)에 포함합니다.

브라우저 검증은 저장소에 설치된 Playwright Chromium과 axe를 사용합니다. 새 라이브러리·브라우저를
설치하거나 외부 서비스를 호출하지 않습니다. CSP `connect-src 'none'`과 테스트의 네트워크 차단을 유지합니다.
