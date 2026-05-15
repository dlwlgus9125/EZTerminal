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

## Relationships

- A **Tab** contains exactly one **LayoutNode** tree (binary tree of panes).
- Each **LeafNode** maps 1:1 to a **pane**, which maps 1:1 to a **PTY session**.
- **Rail panels** and **floating panels** share the same component (PanelHost) but differ in lifecycle ownership.
- **Data frame** coalescing happens in the main process; **animation frame** scheduling happens in the renderer.
