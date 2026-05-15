---
doc_type: reference
authority: canonical
status: active
---

# UX Specification

EZTerminal UI contracts and visual specifications.

## Layout Structure

```
+------------------------------------------+
| TitleBar (32px)                          |
+------------------------------------------+
| TabBar (36px)                            |
+------+---------+------------------------+
|      |         |                        |
|      | Terminal | Panel (300px)          |
| Rail |  Area   | (Status/Network/       |
| 48px |         |  Settings)             |
|      |         |                        |
+------+---------+------------------------+
| StatusBar (22px)                         |
+------------------------------------------+
```

### Dimensions

| Element | Size | Constraint |
|---------|------|------------|
| TitleBar | 32px height | Fixed, custom (frameless window) |
| TabBar | 36px height | Fixed |
| Rail | 48px width | Fixed, left side |
| Panel | 300px width | Fixed, right side, collapsible |
| StatusBar | 22px height | Fixed, bottom |
| Terminal | Remaining space | Fills between Rail and Panel |
| Min window | 800x600 | Enforced by BrowserWindow minWidth/minHeight |
| Split gutter | 6px | Draggable, double-click resets to 50:50 |

## Keyboard Shortcuts

| Shortcut | Action | Context |
|----------|--------|---------|
| Ctrl+T | New tab | Global |
| Ctrl+W | Close tab | Global (blocked if last tab) |
| Ctrl+Tab | Next tab | Global |
| Ctrl+Shift+Tab | Previous tab | Global |
| Ctrl+1~9 | Direct tab switch (9=last) | Global |
| Ctrl+Shift+D | Split right | Terminal |
| Ctrl+Shift+E | Split down | Terminal |
| Ctrl+Shift+W | Close pane | Terminal (blocked if last pane in last tab) |
| Ctrl+Shift+Z | Toggle zoom | Terminal |
| Ctrl+Alt+Arrow | Focus adjacent pane | Terminal |
| Ctrl+C | Copy selection / SIGINT | Terminal (selection-dependent) |
| Ctrl+V | Paste (bracketed paste) | Terminal |
| Ctrl+F | Find bar | Terminal |
| Ctrl+Shift+P | Command palette | Global |
| ESC | Close overlay (find/palette/menu) | Overlay active |

## Theme

### Phosphor 17 Token Mapping

Applied via `[data-theme='dark']` attribute on root element.

| Usage | Token | Description |
|-------|-------|-------------|
| Background | `--p-bg-base` | Main app background |
| Surface | `--p-bg-surface` | Panels, tab bar |
| Border | `--p-border-default` | Dividers, gutters |
| Text primary | `--p-text-primary` | Main text |
| Text secondary | `--p-text-secondary` | Labels, hints |
| Accent | `--p-accent-primary` | Active states, selections |
| Danger | `--p-danger` | Error states, 90%+ disk usage |
| Chart primary | `--p-chart-green` | CPU/memory/traffic charts |

### xterm.js Theme

xterm.js theme object generated from Phosphor tokens at TerminalView mount time. Maps foreground, background, cursor, selection, and ANSI color palette.

## Panel Behavior

| Rule | Description |
|------|-------------|
| Lazy creation | Panel content instantiated on first open, not at app start |
| Visibility lifecycle | Collectors start on panel show, stop on panel hide (ADR-006) |
| Toggle | Click active Rail icon → collapse panel |
| Switch | Click different Rail icon → switch panel content |
| Floating | Pop-out button → new BrowserWindow; Dock button → return to main |
| Minimize sync | Main window minimize → stop all collectors; floating minimize → stop that panel's collector |

## Context Menu (Terminal)

12 items in order:
1. Copy
2. Paste
3. Paste & Run
4. ---
5. Find
6. Save Scrollback
7. Clear
8. Reset Shell
9. Kill Process
10. ---
11. Split Right
12. Split Down
13. Close Pane

Positioned to avoid screen edge overflow. Keyboard navigable (Arrow + Enter). Dismissed by ESC or outside click.

## Command Palette

14 commands: New Tab, Close Tab, Split Right, Split Down, Close Pane, Toggle Zoom, Focus Next Pane, Toggle Status, Toggle Network, Toggle Settings, Find, Clear Terminal, Reset Shell, Kill Process.

Substring filter (case-insensitive). Enter executes, ESC dismisses.

## StatusBar Content

| Segment | Content |
|---------|---------|
| Left | Shell name (e.g., "PowerShell") |
| Center | Terminal size (e.g., "80x24") |
| Right | Encoding, Command Palette link |
