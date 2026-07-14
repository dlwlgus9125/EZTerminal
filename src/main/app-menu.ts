import type { MenuItemConstructorOptions } from 'electron';
import type { ResolvedUiLocale } from '../shared/ui-preferences';

const labels = {
  en: {
    file: 'File',
    quit: 'Quit',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    view: 'View',
    devTools: 'Developer Tools',
    resetZoom: 'Reset Zoom',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    fullscreen: 'Toggle Full Screen',
    window: 'Window',
    minimize: 'Minimize',
  },
  ko: {
    file: '파일',
    quit: '종료',
    edit: '편집',
    undo: '실행 취소',
    redo: '다시 실행',
    cut: '잘라내기',
    copy: '복사',
    paste: '붙여넣기',
    selectAll: '모두 선택',
    view: '보기',
    devTools: '개발자 도구',
    resetZoom: '확대/축소 초기화',
    zoomIn: '확대',
    zoomOut: '축소',
    fullscreen: '전체 화면 전환',
    window: '창',
    minimize: '최소화',
  },
} as const;

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
export function buildMenuTemplate(locale: ResolvedUiLocale = 'en'): MenuItemConstructorOptions[] {
  const text = labels[locale];
  return [
    {
      label: text.file,
      submenu: [{ label: text.quit, role: 'quit' }],
    },
    {
      label: text.edit,
      submenu: [
        { label: text.undo, role: 'undo' },
        { label: text.redo, role: 'redo' },
        { type: 'separator' },
        { label: text.cut, role: 'cut' },
        { label: text.copy, role: 'copy' },
        { label: text.paste, role: 'paste' },
        { label: text.selectAll, role: 'selectAll' },
      ],
    },
    {
      label: text.view,
      submenu: [
        { label: text.devTools, role: 'toggleDevTools' },
        { type: 'separator' },
        { label: text.resetZoom, role: 'resetZoom' },
        { label: text.zoomIn, role: 'zoomIn' },
        { label: text.zoomOut, role: 'zoomOut' },
        { type: 'separator' },
        { label: text.fullscreen, role: 'togglefullscreen' },
      ],
    },
    {
      label: text.window,
      submenu: [{ label: text.minimize, role: 'minimize' }],
    },
  ];
}
