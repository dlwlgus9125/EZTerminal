# ADR-001: Electron 3-Layer + Typed IPC

## Status
Accepted

## Context
EZTerminal을 C# Avalonia에서 Electron으로 전환한다. Electron은 main/renderer 2-process 모델이지만, 보안을 위해 preload 계층을 추가하여 3-layer로 구성해야 한다. renderer에서 Node.js API 직접 접근은 보안 위험(RCE). contextBridge를 통한 typed IPC가 유일한 안전한 cross-process 통신 수단.

## Decision
main (Node.js) / preload (contextBridge) / renderer (React) 3계층 분리. nodeIntegration: false, contextIsolation: true. 모든 IPC는 preload에서 노출하는 typed API를 통해서만 진행. TypeScript 인터페이스로 IPC 채널 타입 안전성 보장.

## Consequences
- Positive: renderer에서 Node.js 접근 불가로 보안 강화, IPC 타입 안전성
- Negative: 모든 cross-process 호출에 IPC 오버헤드, preload 계층 유지 비용
- Follow-up review trigger: IPC 채널이 20개를 초과하면 채널 그룹핑 검토
