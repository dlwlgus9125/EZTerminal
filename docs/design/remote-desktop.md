# PC Control 현재 구현 계약

> 문서 상태: **활성 규범 계약**
>
> 범위: Android에서 Windows의 표시 중인 잠금 해제 데스크톱을 제어하는 현재
> WebRTC·native-host·서비스 경계. Microsoft RDP 구현이 아니다.

## 지원 범위

- Windows 10 22H2/Windows 11 x64 host와 Android 10(API 29) 이상 client를 지원한다.
- Electron 앱, remote bridge, 선택된 신뢰 VPN, 설치된 native host 서비스와 활성
  사용자 세션 agent가 모두 준비되어야 한다.
- 선택 모니터 영상, 모니터 전환, cursor, trackpad/direct touch, mouse·keyboard,
  Korean IME, special key와 명시적 text clipboard 동작을 제공한다.
- 한 Android 설치만 controller lease를 가진다. 로컬 화면과 로컬 입력은 계속 보이고
  동작한다.
- lock screen, UAC secure desktop, pre-logon, privacy mode, audio와
  Software SAS/Ctrl+Alt+Delete는 현재 지원하거나 광고하지 않는다.

## 프로세스와 권한 경계

`ezterminal-remote-host.exe`는 다음 모드를 명시적으로 분리한다.

```text
Android -- authenticated WS signaling --> Electron main
Android <--------- VPN-bound WebRTC -----> --transport (normal user)
Electron/transport -- verified named pipe --> RemoteService (LocalSystem)
RemoteService -- nonce-bound channel --> --session-agent (active session)
```

- Electron main의 `RemoteDesktopController`가 controller lease와 native transport
  lifecycle을 직렬화하고 bounded stdio protocol로 signaling을 전달한다.
- `--transport`가 DXGI Desktop Duplication 우선/GDI fallback capture,
  Media Foundation hardware 우선/OpenH264 software fallback encode, WebRTC와 실제
  `SendInput`을 일반 사용자 권한에서 수행한다.
- LocalSystem service는 네트워크 listener를 열거나 SDP/RTP를 파싱하지 않는다. local
  pipe client의 PID, executable identity, user SID와 active session을 검증하고 bounded
  capability lease를 발급한다.
- `--session-agent`는 활성 사용자 세션에서 capability와 heartbeat를 증명한다. 현재
  capture/input 구현의 소유권이 service agent로 이전되었다고 문서화하지 않는다.
- service, agent 또는 transport identity/liveness 검증이 실패하면 graphical control만
  fail closed하고 terminal remote access는 유지한다.

## 네트워크와 signaling

- PC Control capability는 인증 WebSocket이 신뢰 VPN interface로 수락되었을 때만
  제공한다.
- SDP와 ICE는 bounded shared protocol message이며 임의 socket handler에서 별도로
  파싱하지 않는다.
- WebRTC UDP bind 주소는 인증 WebSocket을 받은 같은 신뢰 adapter 주소다. peer 주소가
  인증 connection과 다르면 거부한다.
- 애플리케이션은 public relay, cloud signaling, router forwarding을 만들지 않는다.
- control channel은 key/button/clipboard/display 같은 신뢰성 필요한 event를 ordered로,
  pointer motion은 손실 가능한 channel로 분리한다. press/release를 손실 가능한 channel에
  보내지 않는다.

## lease와 정리

- 첫 유효 client가 controller lease를 얻고 다른 clientId는 bounded `busy` 상태를 받는다.
- 예상치 못한 WS/ICE 손실 뒤 같은 clientId에는 15초 resume grace를 제공한다. 이 동안
  input은 즉시 중단되며 다른 client가 takeover하지 않는다.
- desktop banner/tray/Remote panel의 Disconnect, bridge 비활성화, token 회전, 앱 종료가
  mobile 요청보다 우선한다.
- 모든 stop path는 눌린 key/button을 release하고 native transport, service lease와
  session capability를 bounded 시간 안에 정리한다.
- stale signal, 이전 sessionId 또는 종료 뒤 도착한 input은 무시하거나 명시적으로
  거부한다.

## 영상, 입력과 clipboard

- DXGI Desktop Duplication은 선택된 physical-pixel display를 우선 capture한다. 출력이
  회전되어 있거나 duplication 생성/실행이 실패하면 동일 geometry의 GDI path로 즉시
  내려간다. Media Foundation hardware H.264를 우선 사용하고 초기화·type 협상·frame event가
  실패하면 같은 frame부터 OpenH264 software로 전환한다. 상태에는 실제로 frame을 만든
  `dxgi`/`gdi`, `media-foundation-hardware`/`openh264-software` backend만 보고한다.
- Fit에서는 선택 display 전체를 보존한다. Zoom에서는 client가 normalized visible region과
  단조 증가 revision을 보내고 host는 경계 안의 overscan ROI만 capture한 뒤 mobile encode
  surface까지 확대한다. 새 frame이 실제 전송된 다음 `view-applied`로 revision, 실제 source
  region과 frame size를 회신한다. Client는 이 응답으로 decoded video layout과 absolute
  input authority를 맞춘다.
- Quality preference는 Balanced, Clarity, Responsiveness다. 해상도·목표 fps·pixel당
  bitrate와 상하한을 함께 바꾸고, packet loss·RTT·send backlog뿐 아니라 client decoded
  fps, dropped frame과 freeze를 adaptive tier 입력으로 사용한다. Encoder GOP는 약 1초로
  유지해 view/quality 전환 뒤 recovery를 제한한다.
- `adaptive-region-v1`, `quality-preference-v1`, `client-video-stats-v2`는 native ready의
  optional feature로 협상한다. Feature가 없는 기존 v2 native host에는 protocol을 깨지 않고
  기존 adaptive viewport와 legacy dropped-frame stats만 사용한다.
- monitor 목록에는 안정된 identifier, bounds, rotation과 primary 정보가 포함된다.
  선택 모니터가 사라지면 안전한 fallback과 상태 갱신을 수행한다.
- pointer 좌표는 선택 display와 rotation 기준으로 검증한다. input sequence와 active
  lease가 일치하지 않으면 `SendInput`을 호출하지 않는다.
- clipboard는 active controller의 명시적 Send/Copy 동작에서 text만 처리한다. 자동
  동기화나 terminal clipboard query 응답을 제공하지 않는다.
- frame, input, clipboard, SDP/ICE, token과 pipe capability를 로그에 남기지 않는다.

## capability와 실패 의미

제품 UI는 unavailable, idle, starting, active, reconnecting, busy, stopping과 error를
구분한다. bridge, VPN, service, agent, capture, encoder와 transport 실패를 하나의
일반 오류로 숨기지 않는다. 준비되지 않은 capability는 disabled 성공으로 가장하지
않고 광고 단계에서 닫는다.

미지원 secure-desktop 목표나 과거의 target architecture를 현재 계약에 섞지 않는다.
그 기록은 아카이브에 남고, 새 지원을 추가할 때는 권한 경계와 위협 모델을 별도 제품
결정으로 갱신한다.

## 근거 소스

- [`src/main/remote-desktop-controller.ts`](../../src/main/remote-desktop-controller.ts)
- [`src/main/native-desktop-protocol.ts`](../../src/main/native-desktop-protocol.ts)
- [`src/shared/remote-protocol.ts`](../../src/shared/remote-protocol.ts)
- [`native/remote-host/src/main.rs`](../../native/remote-host/src/main.rs)
- [`native/remote-host/src/service.rs`](../../native/remote-host/src/service.rs)
- [`native/remote-host/src/local_broker.rs`](../../native/remote-host/src/local_broker.rs)
- [`native/remote-host/src/session_agent.rs`](../../native/remote-host/src/session_agent.rs)
- [`native/remote-host/src/transport.rs`](../../native/remote-host/src/transport.rs)
- [`native/remote-host/src/capture.rs`](../../native/remote-host/src/capture.rs)
- [`native/remote-host/src/encoder.rs`](../../native/remote-host/src/encoder.rs)
- [`native/remote-host/src/quality.rs`](../../native/remote-host/src/quality.rs)
- [`mobile/src/MobileRemoteDesktopView.tsx`](../../mobile/src/MobileRemoteDesktopView.tsx)
- [`mobile/src/remote-desktop-presentation-adapter.ts`](../../mobile/src/remote-desktop-presentation-adapter.ts)
- [`mobile/src/remote-desktop-view-state.ts`](../../mobile/src/remote-desktop-view-state.ts)

## 검증

- [`src/main/remote-desktop-controller.test.ts`](../../src/main/remote-desktop-controller.test.ts)
- [`src/main/native-desktop-protocol.test.ts`](../../src/main/native-desktop-protocol.test.ts)
- [`mobile/src/MobileRemoteDesktopView.test.tsx`](../../mobile/src/MobileRemoteDesktopView.test.tsx)
- [`mobile/src/remote-desktop-presentation-adapter.test.ts`](../../mobile/src/remote-desktop-presentation-adapter.test.ts)
- [`mobile/src/remote-desktop-view-state.test.ts`](../../mobile/src/remote-desktop-view-state.test.ts)
- [`native/remote-host/src/lease.rs`](../../native/remote-host/src/lease.rs)
- [`native/remote-host/src/broker.rs`](../../native/remote-host/src/broker.rs)
- [`native/remote-host/src/transport.rs`](../../native/remote-host/src/transport.rs)

과거의 privileged end-state 계획과 당시 검증 기록은
[`remote-desktop-design.md`](../archive/design/remote-desktop-design.md)에 보존한다.
