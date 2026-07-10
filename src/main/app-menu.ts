import type { MenuItemConstructorOptions } from 'electron';

// Terminal-safe application menu (WT-parity M1). Electron's DEFAULT menu binds
// role accelerators that make sense for a text-editor-shaped app but are
// actively dangerous in a terminal: `reload` (Ctrl+R) and `forceReload`
// (Ctrl+Shift+R) steal the shell's reverse-search chord and reload the whole
// app mid-session; the window's `close` role (Ctrl+W) kills the window on a
// keystroke a shell user reaches for constantly (word-delete in many
// readline-style bindings). None of those three roles/accelerators appear
// below — Ctrl+R / Ctrl+Shift+R / Ctrl+W / F5 fall through to the terminal.
//
// The Edit menu's clipboard roles (`undo, redo, cut, copy, paste, selectAll`)
// are KEPT: on Windows, dropping them breaks Ctrl+C/V/X in plain `<input>`
// elements (the command composer, settings fields) because those roles are
// what wires the accelerator to the focused text field in the first place.
// This does not regress terminal Ctrl+C-as-interrupt — the focused xterm
// consumes that key before it reaches the menu (proven by the M0 bug where
// \x03 reached the child process). Terminal-native copy/paste disambiguation
// is a later milestone, not this one.
//
// Pure function, no runtime `electron` import — only the TYPE is used above —
// so this is unit-testable without an Electron runtime.
export function buildMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    {
      label: 'File',
      submenu: [{ role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }],
    },
  ];
}
