# 터미널 클립보드 계약

> 문서 상태: **활성 규범 계약**
>
> 범위: Desktop main window, split pane와 auxiliary window의 사용자 주도 터미널
> 복사. Android·remote terminal과 프로그램 주도 OSC 52 쓰기는 범위 밖이다.

## 현재 계약

사용자가 선택한 터미널 텍스트를 복사하는 모든 desktop 진입점은 하나의 결과 경계를
공유한다. 선택을 소유한 표면은 문자열과 `ownerDocument`를 동기적으로 캡처하고,
[`copyTerminalText`](../../src/renderer/terminal-copy.ts)에 전달한다. 이 경계만 쓰기
capability 호출, 성공 판정과 사용자 알림을 소유한다.

```text
TerminalPane / PtyBlock selection adapter
  -> copyTerminalText({ text, ownerDocument })
  -> TerminalRuntimeOptions.writeUserClipboardText
  -> preload writeTerminalClipboard(text)
  -> main terminal:write-clipboard
  -> Electron OS clipboard
  -> source ownerDocument toast
```

Desktop production에서 사용자 복사는 renderer의 `navigator.clipboard.writeText`에
의존하지 않는다. Context-isolated preload가 최소 IPC capability만 노출하고 Electron
main이 OS clipboard를 쓴다. 모든 terminal runtime은 writer를 타입상 반드시 선택한다.
Storybook이나 Electron이 아닌 host만 명시적인 `writeOwnerDocumentClipboardText` adapter를
공급한다. Writer 누락을 암묵적인 renderer fallback으로 복구하지 않는다.

## 선택 adapter와 진입점

- `TerminalPane`은 composer input, 완료된 command/output와 실행 중 plain PTY 출력의
  DOM selection을 캡처한다. DOM output selection과 input selection이 함께 남아 있으면
  현재 document range인 output selection을 우선한다.
- `PtyBlock`은 plain output의 DOM selection과 xterm의 `getSelection()`을 캡처한다.
- 우클릭과 keyboard context menu는 menu가 focus를 옮기기 전에 선택 문자열을 snapshot한다.
  Menu action은 현재 selection을 다시 읽지 않는다.
- `Ctrl+C`, `Ctrl+Shift+C`, `Ctrl+Insert`와 context-menu Copy는 같은 helper를 호출하며
  사용자 action 하나당 OS write 하나와 결과 toast 하나만 만든다.
- 선택이 없으면 copy를 시도하거나 성공으로 보고하지 않는다. 일반 PTY의 selection 없는
  `Ctrl+C`는 자식 프로세스 interrupt 의미를 유지하고, 직접 실행한 Codex의 기존 종료 방지
  정책도 유지한다.
- Native Edit menu의 표준 Copy role은 일반 editable control을 위해 유지한다. 터미널이
  소유하는 선택과 shortcut은 위 adapter가 처리한다.

## 권한 경계와 실패 의미

[`EzTerminalDesktopApi.writeTerminalClipboard`](../../src/shared/ipc.ts)는 문자열 하나를
받아 `Promise<boolean>`을 반환한다. Preload는 내용을 해석하거나 보관하지 않고
`terminal:write-clipboard`로 전달한다. Main의
[`writeTerminalClipboardText`](../../src/main/terminal-clipboard.ts)는 비어 있지 않은
문자열만 한 번 쓰고, validation 또는 Electron clipboard 예외를 `false`로 변환한다.

- `true`: 원본 document에 localized success toast를 표시한다.
- `false` 또는 rejection: 원본 document에 localized warning과 재시도 안내를 표시한다.
- 선택 문자열은 toast, description, 오류 메시지나 log에 포함하지 않는다.
- 실패를 성공으로 표시하거나 renderer Clipboard API로 몰래 재시도하지 않는다. 중복
  쓰기와 서로 다른 결과가 생기는 것을 막기 위해 복구는 다음 사용자 action이다.

Auxiliary window는 별도 `Document`이므로 비동기 IPC가 끝난 뒤에도 최초 캡처한
`ownerDocument`를 알림에 사용한다. Main window의 현재 focus를 다시 조회해 알림 위치를
추측하지 않는다.

## OSC 52와의 분리

사용자 선택 복사의 `writeUserClipboardText`와 프로그램 주도 OSC 52의
`writeOsc52ClipboardText`는 이름과 policy가 다른 capability다. OSC 52는 opt-in, 크기,
rate-limit과 side-effect suppression을 계속 적용하며 사용자 Copy helper나 성공 toast를
통과하지 않는다. 두 경로를 하나의 generic `writeClipboardText`로 합치지 않는다.

## 근거 소스

- [`src/renderer/TerminalPane.tsx`](../../src/renderer/TerminalPane.tsx)
- [`src/renderer/PtyBlock.tsx`](../../src/renderer/PtyBlock.tsx)
- [`src/renderer/terminal-copy.ts`](../../src/renderer/terminal-copy.ts)
- [`src/renderer/xterm-runtime.ts`](../../src/renderer/xterm-runtime.ts)
- [`src/preload/preload.ts`](../../src/preload/preload.ts)
- [`src/main/terminal-clipboard.ts`](../../src/main/terminal-clipboard.ts)
- [`src/shared/ipc.ts`](../../src/shared/ipc.ts)

## 검증

변경 시 다음 회귀 표면을 유지한다.

- main clipboard writer: 정상 쓰기, 빈/잘못된 payload 거부, Electron 예외의 `false` 변환.
- shared renderer helper: writer 성공·`false`·rejection, source document 전달, feedback에
  선택 문자열이 섞이지 않음, non-Electron fallback.
- plain/xterm context menu: menu focus 이후에도 invocation snapshot을 정확히 복사.
- main/split desktop: renderer Clipboard API를 강제로 거부해도 우클릭과 keyboard copy가
  OS clipboard를 갱신하며 selection 없는 interrupt 의미를 보존.
- main writer 실패: 기존 clipboard를 보존하고 안전한 failure toast를 표시.
- auxiliary window: OS clipboard를 갱신하고 success/failure feedback을 호출한 document에만
  표시.
- packaged EXE: source checkout이 아닌 새 package에서 preload IPC와 main handler를 포함한
  실제 경계를 검증.

현재 자동화 근거는 다음과 같다.

- [`src/main/terminal-clipboard.test.ts`](../../src/main/terminal-clipboard.test.ts)
- [`src/renderer/terminal-copy.test.ts`](../../src/renderer/terminal-copy.test.ts)
- [`src/renderer/PtyBlock.context-menu.test.tsx`](../../src/renderer/PtyBlock.context-menu.test.tsx)
- [`src/renderer/terminal-key-policy.test.ts`](../../src/renderer/terminal-key-policy.test.ts)
- [`e2e/splits.spec.ts`](../../e2e/splits.spec.ts)
- [`e2e/popout-interaction-parity.spec.ts`](../../e2e/popout-interaction-parity.spec.ts)
- [`e2e-packaged/terminal-copy-packaged.spec.ts`](../../e2e-packaged/terminal-copy-packaged.spec.ts)

Terminal copy를 추가하거나 변경할 때 component에서 직접 `navigator.clipboard.writeText`를
호출하지 않는다. 새 selection surface는 capture adapter만 추가하고 transport와 feedback은
`copyTerminalText`를 재사용한다.
