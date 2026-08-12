# 원격 터미널 계약

> 문서 상태: **활성 규범 계약**
>
> 범위: 데스크톱 remote bridge, Android WebSocket transport, 페어링, capability,
> 세션·실행 복구와 원격 파일·도구 접근.

## 현재 계약

Android 앱은 별도 셸을 실행하지 않는다. 인증된 WebSocket transport가 데스크톱의
`InterpreterBroker`와 main 서비스에 연결되고, 데스크톱 renderer가 사용하는 API와
같은 의미의 adapter를 제공한다. 로컬과 원격 실행은 동일한 세션·run·MessagePort
계약을 공유한다.

## 네트워크와 인증

- Remote bridge는 기본적으로 꺼져 있으며 사용자가 선택한 Tailscale, WireGuard 또는
  명시적으로 신뢰한 VPN interface 주소에만 bind한다.
- listener를 시작하기 전에 interface와 주소의 현재 소유 관계를 검증한다. 선택이
  사라지거나 다른 adapter로 이동하면 capability를 계속 광고하지 않는다.
- 새 socket은 다른 요청보다 먼저 token 인증과 protocol negotiation을 끝내야 한다.
  인증 전에는 세션, 파일, 상태 또는 오류 세부 정보를 제공하지 않는다.
- bearer token은 desktop main이 소유하며 Windows에서는 OS-backed encryption을
  사용한다. 비교는 timing-safe하게 수행하고 token 회전은 기존 권한을 폐기한다.
- Android connection credential은 Keystore-backed 저장소에만 보존한다. 보안 저장을
  확인할 수 없으면 plaintext로 대체 저장하지 않는다.
- `ws://`는 사용자가 선택한 암호화 VPN 내부 transport다. 공용 LAN이나 인터넷에
  자동 노출하거나 router forwarding을 만들지 않는다.

## 프로토콜과 capability

현재 wire version은 [`remote-protocol.ts`](../../src/shared/remote-protocol.ts)의
version 7이며 지원 목록도 version 7 하나다. 버전은
[`release/version.json`](../../release/version.json)과 함께 갱신한다.

- 모든 message는 공유 discriminated union과 bounded validator를 통과한다.
- server는 인증 완료 뒤 실제로 준비된 capability만 광고한다. 요청 message가 존재하는
  것과 capability가 준비된 것은 같은 의미가 아니다.
- 호환되지 않는 version은 지원 version을 알리고 종료한다. 클라이언트가 낮은 version의
  기능을 추측하거나 조용히 무시하지 않는다.
- session-surface authority가 wire contract에 포함된다. 표면 등록·해제·세션 파괴는
  main의 동일한 권한 검사를 거친다.

## Android transport

`WsEzTerminalTransport`는 실행별 `FakeMessagePort`를 제공해 desktop의
`BlockController`와 같은 frame/control 의미를 재사용한다. 별도 모바일 명령 실행기를
만들거나 frame 종류를 임의로 번역하지 않는다.

- connect는 auth watchdog과 bounded exponential backoff를 사용한다.
- 단순 연결 timeout은 사용자에게 상태를 보여 주되 아직 유효한 자동 재연결 경로를
  즉시 파괴하지 않는다.
- 인증 거부와 protocol 불일치는 자동 재시도를 멈추고 재페어링 또는 업데이트를
  요구한다.
- 연결 중에도 mounted workbench, draft, scroll과 terminal controller를 보존한다.
  opaque reconnect UI 아래에서 새 입력과 부수효과는 막는다.
- 성공한 재인증 뒤 구독, 세션 목록, 표면과 attach 가능한 실행을 재구성한 다음 live
  frame을 연다.
- Capacitor `appStateChange`가 background를 알리면 짧은 grace 동안 현재 연결을 유지하고,
  grace를 넘으면 transport를 `suspended`로 전환한다. 이 전환은 reconnect timer와 socket만
  정리하고 session surface, run lease, 안정적인 virtual port와 UI state는 보존한다.
- Foreground 복귀는 동시에 들어온 native/page visibility 신호를 하나로 합쳐 한 번만
  재연결한다. 인증 뒤 기존 surface와 run을 resume하고, 중복 socket이나 중복 attach를
  만들지 않는다.
- Background suspend는 사용자의 명시적 Disconnect가 아니다. Disconnect만 surface와
  run 권한을 의도적으로 반납하고 화면을 파괴하는 destructive 경로를 사용한다.

## 실행 소유권과 복구

- 원격에서 시작한 run은 client installation과 run identity에 묶인 lease를 가진다.
  일시 단절 후에도 최대 5분 동안 orphaned run port를 보존해 같은 설치가 다시 attach할
  수 있다.
- 사용자가 명시적으로 Disconnect하면 복구 권한을 반납한다. 네트워크 단절과 사용자
  Disconnect를 같은 사건으로 취급하지 않는다.
- local PTY attach는 snapshot/tail 연속성을 확인하고 실패 시 bounded fallback과 경고를
  제공한다. SSH late attach는 현재 fail closed한다.
- 실행 input owner와 관찰 surface는 구분한다. 재연결한 client가 stale socket의 입력과
  경쟁하지 못하도록 generation과 surface identity를 검사한다.

## 원격 서비스 표면

인증된 Android는 capability에 따라 터미널, 파일 탐색·전송, stats, quick commands,
Agent 상태·이력·프로젝트, OpenClaw와 PC Control 진입점을 사용할 수 있다.

- 파일 경로는 desktop main의 root/capability 검증을 거친다. 모바일이 임의의 local
  경로를 renderer 권한으로 열지 않는다.
- 업로드·다운로드·preview는 크기와 chunk 상한을 가지며 중단 시 임시 상태를 정리한다.
- stats와 packet 정보는 UI visibility/subscription이 있을 때만 producer를 활성화한다.
- OpenClaw chat은 gateway token 대신 main이 발급한 짧은 수명의 ticket을 사용한다.
- PC Control은 별도 [`remote-desktop.md`](remote-desktop.md)의 준비 조건을 모두
  충족할 때만 광고한다.

## 실패와 보안 불변조건

- token, 명령 내용, transcript, 파일 내용과 clipboard를 연결 진단에 포함하지 않는다.
- 인증 실패가 terminal session이나 파일 존재 여부를 누설하지 않는다.
- malformed, oversized, out-of-order message는 해당 요청 또는 연결을 fail closed하고
  process crash로 확대하지 않는다.
- remote bridge 장애가 로컬 terminal을 중단해서는 안 된다.
- desktop main을 우회하는 Android 전용 business logic을 추가하지 않는다.

## 근거 소스

- [`src/main/remote-runtime.ts`](../../src/main/remote-runtime.ts)
- [`src/main/remote-bridge.ts`](../../src/main/remote-bridge.ts)
- [`src/main/remote-token-store.ts`](../../src/main/remote-token-store.ts)
- [`src/main/trusted-remote-network.ts`](../../src/main/trusted-remote-network.ts)
- [`src/main/remote-run-lease.ts`](../../src/main/remote-run-lease.ts)
- [`src/shared/remote-protocol.ts`](../../src/shared/remote-protocol.ts)
- [`mobile/src/transport/ws-ezterminal.ts`](../../mobile/src/transport/ws-ezterminal.ts)
- [`mobile/src/mobile-app-lifecycle.ts`](../../mobile/src/mobile-app-lifecycle.ts)
- [`mobile/src/connection-credential-store.ts`](../../mobile/src/connection-credential-store.ts)

## 검증

- [`src/main/remote-bridge.test.ts`](../../src/main/remote-bridge.test.ts)
- [`src/main/remote-runtime.test.ts`](../../src/main/remote-runtime.test.ts)
- [`src/main/trusted-remote-network.test.ts`](../../src/main/trusted-remote-network.test.ts)
- [`mobile/src/transport/ws-ezterminal.test.ts`](../../mobile/src/transport/ws-ezterminal.test.ts)
- [`mobile/src/mobile-app-lifecycle.test.ts`](../../mobile/src/mobile-app-lifecycle.test.ts)
- [`mobile/src/connection-credential-store.test.ts`](../../mobile/src/connection-credential-store.test.ts)
- [`e2e/remote-resume-stall.spec.ts`](../../e2e/remote-resume-stall.spec.ts)
- [`mobile/e2e/smoke.ts`](../../mobile/e2e/smoke.ts)

과거 최초 모바일 구현 계획은
[`mobile-remote-control-design.md`](../archive/design/mobile-remote-control-design.md)에
보존한다.
