# EZTerminal Domain Language

## Language

**session** — PTY session: a node-pty process identified by UUID, created per pane and destroyed on pane close. Not to be confused with Electron session (BrowserWindow session context).
_Avoid:_ "세션" without qualifier — always say "PTY session" or "Electron session".

**panel** — Rail panel: a docked content area (Status, Network, Settings) at 300px width on the right side, toggled via Rail icons. Floating panel: a detached BrowserWindow hosting the same content for multi-monitor use.
_Avoid:_ "패널" without qualifier — always say "rail panel" or "floating panel".

**frame** — Data frame: a 16ms coalesced chunk of PTY stdout data sent as a single IPC event (ADR-003). Animation frame: a requestAnimationFrame callback used for chart rendering.
_Avoid:_ "프레임" without qualifier — always say "data frame" or "animation frame".

**resize** — Terminal resize: a change in logical cols/rows that triggers PTY resize via IPC. Window resize: a viewport dimension change that may or may not change cols/rows (panel toggle without cols change does NOT trigger PTY resize).
_Avoid:_ "리사이즈" without qualifier — always say "terminal resize" or "window resize".

**traffic** — Network traffic: RX/TX bytes-per-second statistics per interface. Collected via systeminformation (fallback) or cap (Npcap). Distinct from packet capture which records individual packets.
_Avoid:_ "트래픽" interchangeably with "캡처" — traffic is aggregate statistics, capture is individual packet recording.

**capture** — Packet capture: raw packet recording via cap library (requires Npcap). Records individual packets with headers and payload. Disabled gracefully when Npcap is absent.
_Avoid:_ "캡처" when meaning traffic statistics — use "traffic" for aggregate data.

## Relationships

- A **Tab** contains exactly one **LayoutNode** tree (binary tree of panes).
- Each **LeafNode** maps 1:1 to a **pane**, which maps 1:1 to a **PTY session**.
- **Rail panels** and **floating panels** share the same component (PanelHost) but differ in lifecycle ownership.
- **Data frame** coalescing happens in the main process; **animation frame** scheduling happens in the renderer.
- **Traffic** collection and **packet capture** are independent systems: traffic uses systeminformation (no Npcap needed), capture requires Npcap via cap library.
- IPC channels use two patterns: `invoke/handle` for request-response, `send/on` for fire-and-forget commands and push events. PTY data uses per-session channels (`pty:data:{id}`).
