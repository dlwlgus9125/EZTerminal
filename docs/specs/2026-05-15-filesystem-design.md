---
doc_type: spec
authority: derived
status: draft
id: spec-4
date: 2026-05-15
---

# Filesystem & Scrollback Design

Files panel (CWD file explorer + text/image/HTML preview), Save Scrollback, directory watching, custom file protocol.

## Architecture Baseline

**Selected approach:** Extend existing 3-layer IPC architecture with 2 new main services (FilesystemService, ScrollbackService). CWD detection via OSC 7 primary + Win32 API fallback. File tree via Node.js `fs.readdir` + `fs.stat`. Preview: text (UTF-8, 1MB), image (ezterm-file:// custom protocol), HTML (sandboxed iframe via ezterm-file://), binary (metadata only). Virtual scrolling for large directories.

**New Modules:**

| Module | Responsibility | Public Interface |
|--------|---------------|------------------|
| main/filesystem | CWD readdir, file stat, text preview read, CWD query | FilesystemService: readDir/readPreview/getCwd |
| main/scrollback | Save dialog + scrollback text write | ScrollbackService: saveScrollback |
| main/protocol | ezterm-file:// custom protocol registration | registerFileProtocol at app ready |
| renderer/stores (filesSlice) | File tree state, selected file, preview, CWD | filesSlice: tree, selectedPath, previewData, cwdPath |
| renderer/components/FilesPanel | File tree + preview + context menu UI | FilesPanel, FileTree, FilePreview, FileContextMenu |

**New IPC Channels (7):**

| Channel | Direction | Type | Signature |
|---------|-----------|------|-----------|
| `fs:readdir` | R->M | invoke/handle | `(dirPath: string) => DirEntry[]` |
| `fs:readPreview` | R->M | invoke/handle | `(filePath: string) => FilePreview` |
| `fs:getCwd` | R->M | invoke/handle | `(sessionId: string) => string` |
| `fs:watchDir` | R->M | invoke/handle | `(dirPath: string) => void` |
| `fs:unwatchDir` | R->M | invoke/handle | `(dirPath: string) => void` |
| `fs:changed` | M->R | send/on | `(event: FsChangeEvent) => void` |
| `scrollback:save` | R->M | invoke/handle | `(text: string) => { saved: boolean; path?: string }` |

**Allowed dependencies (additions):**
- main/filesystem -> fs, path (Node.js), chokidar 4.x
- main/scrollback -> electron (dialog), fs
- main/protocol -> electron (protocol), fs, path
- main/ipc -> main/filesystem, main/scrollback (addition)
- renderer/terminal -> @xterm/addon-serialize (addition to WM-REG4)
- renderer/components -> @tanstack/react-virtual (virtual scrolling)

**Forbidden dependencies (unchanged):**
- renderer -> Node.js (fs, path, child_process)
- renderer -> electron (no ipcRenderer direct)
- main/filesystem -> renderer modules

**Data ownership (additions):**

| Data | Owner | Access Pattern |
|------|-------|---------------|
| File tree | main/filesystem (computed) | renderer requests via IPC, caches in filesSlice |
| File preview | main/filesystem (text) / renderer (image/HTML via protocol) | text: IPC response. image/HTML: ezterm-file:// direct load |
| CWD per session | main/filesystem (Win32 fallback) / renderer (OSC 7) | OSC 7 updates filesSlice directly; fallback queries main |
| Scrollback text | renderer (xterm.js SerializeAddon) | serialized in renderer, sent to main for file write |

**Operational requirements (additions):**
- Error handling: fs operations throw -> rejected Promise via invoke. Permission denied / path not found -> user-facing error in Files panel, no crash
- External dependency: chokidar 4.x (pure JS, no native), @xterm/addon-serialize, @tanstack/react-virtual
- Configuration: no new settings.json fields for v1.0 (CWD detection mode is auto, not user-configurable)

## ASR Ledger

| ID | Quality Attribute | Target | Design Impact | Verify |
|----|-------------------|--------|---------------|--------|
| ASR-8 | Security | No Node.js in renderer | contextBridge only, no nodeIntegration. Cross-ref: defined in spec-1 (terminal-shell-design.md). Applies to R8 preload extension | `bash -c '! grep -r "require(" src/renderer/'` |
| ASR-9 | Performance | readdir < 200ms (any directory size) | Streaming readdir, no recursive scan | `pnpm test -- --run --grep "readdir-perf"` |
| ASR-10 | Performance | text preview load < 500ms (1MB file) | 1MB size cap, truncation flag | `pnpm test -- --run --grep "preview-perf"` |
| ASR-11 | Security | No arbitrary file read from renderer | ezterm-file:// image extension whitelist + path traversal validation | `pnpm test -- --run --grep "protocol-security"` |
| ASR-12 | Security | No script execution in HTML preview | Sandboxed iframe, CSP, no allow-scripts | `pnpm test -- --run --grep "html-preview-sandbox"` |
| ASR-13 | Performance | CWD fallback detect < 2s | Win32 API polling at 2s interval; OSC 7 instant when available | `pnpm test -- --run --grep "cwd-fallback-latency"` |

## Option Matrix

| Decision | Option A (Selected) | Option B (Rejected) | Tradeoff |
|----------|-------------------|-------------------|----------|
| CWD detection | OSC 7 + Win32 API fallback (ADR-008) | Polling only | OSC 7: instant, zero overhead when shell supports it. Fallback: 2s poll covers cmd.exe/default PowerShell. Polling-only: consistent but always has latency + CPU cost |
| Image preview transport | Custom file protocol ezterm-file:// (ADR-009) | base64 IPC | base64: 5MB image -> 6.7MB IPC payload, blocks main event loop, risks ASR-1 key-to-pty latency. Protocol: zero IPC overhead, renderer loads directly |
| HTML preview | Sandboxed iframe via ezterm-file:// | Electron webview tag | webview: separate process per preview, heavy resource cost. iframe sandbox: lightweight, CSP blocks scripts, sufficient for rendered HTML viewing |
| Large directory rendering | Virtual scrolling (@tanstack/react-virtual) | Truncation at 500 items | Truncation: simple but hides files. Virtual scroll: renders all items, constant memory, proven library |
| File watching | chokidar 4.x | Node.js fs.watch direct | fs.watch: Windows quirks (network drive, event batching). chokidar: cross-platform normalization, pure JS in v4 |

## Lifecycle And Operations

- **Lifecycle stage:** Production (extending existing Electron app)
- **Startup:** main/protocol registered at app.whenReady (before BrowserWindow). FilesystemService created at Stage 5 (with IPC). ScrollbackService created at Stage 5 (stateless)
- **Shutdown:** chokidar watcher.close() in FilesystemService.dispose(). No file handles to leak
- **Visibility lifecycle (ADR-006):** FilesPanel watcher follows `useVisibilityLifecycle` hook. Panel open + window active = watcher active. Window minimized = watcher paused. Panel closed = watcher stopped. Floating window variant: watcher binds to floating window visibility. This matches the existing pattern used by MetricsService and NetworkService collectors
- **Deployment:** No change (Electron Forge make)
- **Migration:** No settings schema change
- **Observability:** console logging for fs errors and watcher events
- **Recovery:** readdir failure -> empty tree + error message. Preview failure -> "Cannot preview" message. Watcher failure -> manual refresh available
- **Ownership:** single developer

## Quality Budgets

| Category | Budget | Risk if None |
|----------|--------|-------------|
| Performance | readdir <200ms (any size, ASR-9), preview <500ms (1MB, ASR-10), CWD fallback detect <2s (ASR-13) | Slow panel, user frustration |
| Reliability | Permission denied -> error display, not crash. Watcher failure -> graceful degrade to manual refresh | Panel unusable on permission errors |
| Security | ezterm-file:// image-only whitelist, HTML sandbox no-scripts, symlink resolution, no arbitrary read | Renderer escape to filesystem |
| Cost | none declared | Single developer project |
| Maintainability | Biome zero warnings, TypeScript strict | — |

## Wiring Map

| ID | Aspect | Value |
|----|--------|-------|
| WM-EP1 | Entry point | `main()` in `src/main/index.ts` (cross-ref spec-1). Protocol registration added at app.whenReady |
| WM-EP2 | Entry point | `createRoot()` in `src/renderer/main.tsx` (cross-ref spec-1). FilesPanel lazy-created via PanelHost |
| WM-REG5 | Registration | IPC handlers in `src/main/ipc/filesystem.ts`: fs:readdir(invoke), fs:readPreview(invoke), fs:getCwd(invoke), fs:watchDir(invoke), fs:unwatchDir(invoke), fs:changed(send). **Probe: runtime-load** |
| WM-REG6 | Registration | IPC handler in `src/main/ipc/scrollback.ts`: scrollback:save(invoke). **Probe: runtime-load** |
| WM-REG7 | Registration | Zustand filesSlice in `src/renderer/stores/filesSlice.ts`. **Probe: runtime-load** |
| WM-REG8 | Registration | Custom protocol `ezterm-file://` in `src/main/protocol.ts` via protocol.handle(). **Probe: runtime-load** |
| WM-DF5 | Data flow | OSC 7 sequence(string) -> xterm.js Terminal.onOsc7(cwdUri:string) -> parseFileUri(path:string) -> filesSlice.setCwd(path:string) -> electronAPI.fs.readdir(path:string) -> preload invoke('fs:readdir') -> ipcMain.handle('fs:readdir') -> FilesystemService.readDir(path:string) -> fs.readdir(Dirent[]) + fs.stat(Stats) per entry -> DirEntry[] -> renderer filesSlice.setTree(DirEntry[]) |
| WM-DF6 | Data flow | FileTree click(filePath:string) -> filesSlice.setSelected(filePath:string) -> [text] electronAPI.fs.readPreview(filePath:string) -> preload invoke('fs:readPreview') -> ipcMain.handle('fs:readPreview') -> FilesystemService.readPreview(filePath:string) -> fs.readFile(Buffer, {limit:1MB}) -> FilePreview:{type:'text', content:string, size:number, truncated:boolean} -> renderer filesSlice.setPreview(FilePreview) |
| WM-DF7 | Data flow | FileTree click(imagePath:string) -> filesSlice.setSelected(imagePath:string) -> renderer `<img src="ezterm-file://{imagePath}">` -> main protocol.handle('ezterm-file') -> validate extension whitelist(.png,.jpg,.jpeg,.gif,.bmp,.webp,.svg) + resolve symlinks + read file(Buffer) -> net.Response(buffer, mime) -> renderer img rendered |
| WM-DF8 | Data flow | FileTree click(htmlPath:string) -> filesSlice.setSelected(htmlPath:string) -> renderer `<iframe sandbox src="ezterm-file://{htmlPath}">` -> main protocol.handle('ezterm-file') -> validate .html/.htm extension + resolve symlinks + read file(Buffer) -> net.Response(buffer, 'text/html') -> renderer iframe rendered (scripts blocked by sandbox) |
| WM-DF9 | Data flow | ContextMenu "Save Scrollback" click -> SerializeAddon.serialize({excludeModes:true})(text:string) -> electronAPI.scrollback.save(text:string) -> preload invoke('scrollback:save') -> ipcMain.handle('scrollback:save') -> dialog.showSaveDialog({filters:[{name:'Text',extensions:['txt']}]}) -> user picks path(string) -> fs.writeFile(path, text, 'utf8') -> {saved:true, path:string} |
| WM-DF10 | Data flow | CWD fallback: 2s setInterval -> electronAPI.fs.getCwd(sessionId:string) -> preload invoke('fs:getCwd') -> ipcMain.handle('fs:getCwd') -> Win32 NtQueryInformationProcess or /proc/{pid}/cwd(path:string) -> filesSlice.setCwd(path:string) (only if changed) |
| WM-C17 | Contract | `FilesystemService.readDir(dirPath: string): DirEntry[]` where `DirEntry = { name: string; isDirectory: boolean; size: number; modified: number }` |
| WM-C18 | Contract | `FilesystemService.readPreview(filePath: string): FilePreview` where `FilePreview = { type: 'text' \| 'image' \| 'html' \| 'binary'; content: string; size: number; truncated: boolean }` |
| WM-C19 | Contract | `ScrollbackService.saveScrollback(text: string): { saved: boolean; path?: string }` |
| WM-C20 | Contract | `FilesystemService.getCwd(pid: number): string` — Win32 API process CWD query |
| WM-C21 | Contract | `registerEztermFileProtocol(): void` — registers `ezterm-file://` with extension whitelist validation |

## Initialization Order (additions to spec-1)

| Stage | Module | Prerequisite | Readiness Signal |
|-------|--------|-------------|------------------|
| 0 (app.whenReady) | main/protocol | none | ezterm-file:// protocol registered |
| 5 | main/filesystem | none | FilesystemService instance created |
| 5 | main/scrollback | none | ScrollbackService instance created |
| 5 | main/ipc | main/filesystem, main/scrollback (added) | fs:* and scrollback:* handlers registered |

## Decision Log

| # | Decision | ADR Required | Rationale |
|---|----------|-------------|-----------|
| 1 | OSC 7 CWD + Win32 fallback | Yes: ADR-008 | Shell dependency is surprising; fallback strategy is non-obvious; hard to reverse (CWD source shapes Files panel architecture) |
| 2 | Custom file protocol for preview | Yes: ADR-009 | Electron security boundary, surprising for readers who expect IPC; hard to reverse (protocol registration is app-level) |
| 3 | Sandboxed iframe for HTML preview | No | Standard web security pattern, easily reversible |
| 4 | Virtual scrolling | No | Library choice, easily swappable |
| 5 | chokidar 4.x | No | Pure JS, trivially replaceable with fs.watch |
| 6 | SerializeAddon for scrollback | No | Only viable xterm.js API for buffer extraction |

## Requirements

### R1: Files Panel - CWD File Tree

**ASR:** ASR-9
**Input:** Files rail icon clicked (panel open)
**Behavior:** Files panel opens at 300px. Reads active PTY session's CWD via filesSlice.cwdPath. Calls electronAPI.fs.readdir(cwdPath) to load directory entries. Displays file tree with virtual scrolling (@tanstack/react-virtual). Sort: directories first, then alphabetical. Each entry shows icon (folder/file), name, size (files only). Clicking folder expands/collapses children (lazy load on expand). Address bar at top shows current path, editable for manual navigation. Breadcrumb segments clickable. Parent directory (..) navigation via up button or breadcrumb.
**Output:** File tree rendered in Files panel
**Impact scope:**
- renderer/stores: filesSlice (tree, cwdPath, expandedDirs)
- renderer/components: FilesPanel, FileTree, FileTreeItem, AddressBar
- main/filesystem: FilesystemService.readDir
- main/ipc: fs:readdir handler
- preload/api: electronAPI.fs.readdir
**Acceptance criteria:**
- [ ] Given: Terminal CWD is a directory with files and subdirectories
      When: Files panel opened
      Then: Directory entries displayed, directories first, alphabetical sort
      Verify: `pnpm test -- --run --grep "files-panel-tree"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Files panel open showing directory
      When: Subdirectory clicked
      Then: Subdirectory expanded, children loaded and displayed
      Verify: `pnpm test -- --run --grep "files-panel-expand"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Files panel open
      When: Address bar path edited to valid directory and Enter pressed
      Then: Tree navigates to new directory
      Verify: `pnpm test -- --run --grep "files-panel-addressbar"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Directory with 10,000+ entries
      When: Files panel opens that directory
      Then: Panel renders without freeze, virtual scrolling active, directory listing completes
      Verify: `pnpm test -- --run --grep "files-panel-virtual-scroll"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Permission denied on directory: show error message in tree area, no crash
- Empty directory: show "Empty directory" message
- Network drive / slow filesystem: readdir may exceed 200ms, show loading spinner

### R2: CWD Detection

**ASR:** ASR-13
**Input:** Shell command changes working directory (cd, pushd, Set-Location)
**Behavior:** Primary: xterm.js Terminal registers OSC 7 handler. When shell emits `\e]7;file://hostname/path\a`, parse URI to extract path, update filesSlice.cwdPath. Fallback: when OSC 7 not received within 5s of panel open, start 2s polling via electronAPI.fs.getCwd(sessionId) which queries Win32 API for PTY child process CWD. Polling stops when OSC 7 is detected or panel closes. On active pane switch, update CWD to new pane's last known CWD.
**Output:** filesSlice.cwdPath updated, Files panel refreshes tree
**Impact scope:**
- renderer/terminal: OSC 7 handler registration on TerminalView
- renderer/stores: filesSlice.cwdPath, filesSlice.cwdSource ('osc7' | 'poll')
- main/filesystem: FilesystemService.getCwd (Win32 API)
- main/ipc: fs:getCwd handler
**Acceptance criteria:**
- [ ] Given: Shell configured to report working directory via escape sequence
      When: `cd /some/path` executed
      Then: Files panel root path updates to /some/path
      Verify: `pnpm test -- --run --grep "cwd-osc7"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Shell does not emit directory reporting escape sequence (e.g., default Windows command interpreter)
      When: Files panel opened and 5s elapsed
      Then: Fallback polling starts, CWD detected via Win32 API within 2s
      Verify: `pnpm test -- --run --grep "cwd-fallback"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Two panes open with different CWDs
      When: Active pane switched
      Then: Files panel shows new pane's CWD
      Verify: `pnpm test -- --run --grep "cwd-pane-switch"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Shell does not emit OSC 7, fallback polling active
      When: cd executed in terminal
      Then: CWD detected within 2s of the change
      Verify: `pnpm test -- --run --grep "cwd-fallback-latency"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- OSC 7 URI with hostname mismatch: ignore, use path portion only
- Win32 API failure (process exited): retain last known CWD
- PTY session has no child process yet (just created): show user home directory as default

### R3: File Preview

**ASR:** ASR-10, ASR-11, ASR-12
**Input:** File clicked in file tree
**Behavior:** Determine file type by extension:
- **Text** (.txt, .md, .json, .js, .ts, .tsx, .css, .html, .xml, .yaml, .yml, .toml, .ini, .cfg, .log, .sh, .bat, .ps1, .py, .go, .rs, .java, .c, .cpp, .h, .sql, and other common text extensions): Load via electronAPI.fs.readPreview(filePath). Main reads up to 1MB of UTF-8 content. Display in scrollable monospace text area. If truncated, show "(truncated at 1MB)" footer.
- **HTML** (.html, .htm): Load via sandboxed iframe `<iframe sandbox="allow-same-origin" src="ezterm-file://{path}">`. Scripts blocked by sandbox attribute (no allow-scripts). CSS and images within HTML loaded via same ezterm-file:// protocol. Toggle button to switch between rendered view and text source view.
- **Image** (.png, .jpg, .jpeg, .gif, .bmp, .webp, .svg): Load via `<img src="ezterm-file://{path}">`. Max display size fits panel width. No size limit on protocol load (images stream directly, no IPC).
- **Binary** (all other extensions): Show metadata only — file name, size, modified date. No content preview.
**Output:** Preview displayed in Files panel below file tree (split layout)
**Impact scope:**
- renderer/components: FilePreview, TextPreview, HtmlPreview, ImagePreview, BinaryInfo
- renderer/stores: filesSlice.previewData
- main/filesystem: FilesystemService.readPreview (text only)
- main/protocol: ezterm-file:// serves image and HTML files
**Acceptance criteria:**
- [ ] Given: Text file under 1MB selected in file tree
      When: Preview loads
      Then: File content displayed as monospace text
      Verify: `pnpm test -- --run --grep "preview-text"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Text file over 1MB selected in file tree
      When: Preview loads
      Then: First 1MB displayed with "(truncated at 1MB)" footer
      Verify: `pnpm test -- --run --grep "preview-truncated"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Image file selected in file tree
      When: Preview loads
      Then: Image rendered via custom file protocol, fits panel width
      Verify: `pnpm test -- --run --grep "preview-image"`
      Verify-type: lib
      Automatable: true
- [ ] Given: HTML file selected in file tree
      When: Preview loads
      Then: HTML rendered in sandboxed frame, scripts do not execute
      Verify: `pnpm test -- --run --grep "html-preview-sandbox"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Binary file selected in file tree
      When: Preview loads
      Then: Metadata displayed (name, size, date), no content
      Verify: `pnpm test -- --run --grep "preview-binary"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- File deleted between tree load and preview click: show "File not found" error
- Permission denied on file read: show error in preview area
- Zero-byte file: show "Empty file" message
- Very long lines in text preview: horizontal scroll, no wrapping

### R4: File Context Menu

**ASR:** none
**Input:** Right-click on file/folder in file tree
**Behavior:** Context menu with items:
- **Copy Name**: Copy file/folder name to clipboard
- **Copy Path**: Copy full absolute path to clipboard
- **Paste to Terminal**: Write quoted path (`"C:\path\to\file"`) to active pane's PTY session via electronAPI.pty.write. No cd, no Enter — path string only
- **Open in OS**: shell.openPath(filePath) for files, shell.openPath(dirPath) for folders (opens in default file manager)
- Separator
- **Refresh**: Re-read current directory
**Output:** Menu action executed
**Impact scope:**
- renderer/components: FileContextMenu
- renderer/stores: filesSlice (selected item), tabSlice (active pane session ID)
**Acceptance criteria:**
- [ ] Given: File right-clicked in tree
      When: "Copy Path" selected
      Then: Full absolute path in clipboard
      Verify: `pnpm test -- --run --grep "file-context-copy-path"`
      Verify-type: lib
      Automatable: true
- [ ] Given: File right-clicked, terminal has active PTY session
      When: "Paste to Terminal" selected
      Then: Quoted file path written to PTY stdin
      Verify: `pnpm test -- --run --grep "file-context-paste-terminal"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Folder right-clicked
      When: "Open in OS" selected
      Then: OS file manager opens at folder path
      Verify: `pnpm test:e2e -- --grep "file-context-open-os"`
      Verify-type: e2e
      Automatable: true
**Edge cases:**
- Path contains spaces or special characters: quotes handle this
- No active PTY session: "Paste to Terminal" disabled

### R5: Directory Watching

**ASR:** none
**Input:** Files panel visible with a directory loaded
**Behavior:** Follows ADR-006 visibility lifecycle pattern via `useVisibilityLifecycle` hook. Watcher lifecycle is bound to the full visibility state matrix:
- **Panel open + window active:** chokidar watcher active on cwdPath. Events (add, unlink, addDir, unlinkDir) trigger fs:changed IPC push to renderer. Renderer updates filesSlice.tree incrementally.
- **Panel open + window minimized:** watcher paused (watcher.close()). On window restore, fresh readdir + watcher restart.
- **Panel closed (any window state):** watcher stopped. CWD changes stored in filesSlice only. On panel reopen, fresh readdir + new watcher on latest CWD.
- **Floating window:** when Files panel is popped out to floating BrowserWindow, watcher lifecycle binds to floating window visibility instead of main window. Floating window close (dock) transfers watcher ownership back to main window visibility.
- **CWD change while watcher active:** close old watcher, start new watcher on new CWD.
Watcher config: `{ ignoreInitial: true, depth: 0 }` (watch only displayed level, not recursive).
**Output:** File tree updates in real-time when files change on disk
**Impact scope:**
- main/filesystem: chokidar watcher management
- main/ipc: fs:watchDir, fs:unwatchDir handlers, fs:changed push
- renderer/stores: filesSlice incremental tree update
**Acceptance criteria:**
- [ ] Given: Files panel open showing directory
      When: New file created in that directory (externally)
      Then: File appears in tree within 2s
      Verify: `pnpm test -- --run --grep "watch-file-add"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Files panel open showing directory
      When: File deleted from that directory (externally)
      Then: File removed from tree within 2s
      Verify: `pnpm test -- --run --grep "watch-file-remove"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Files panel was closed, CWD changed
      When: Files panel re-opened
      Then: Directory re-read from disk at latest CWD, new watcher started
      Verify: `pnpm test -- --run --grep "watch-reopen-fresh"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Files panel open with active directory watching
      When: Window minimized
      Then: Directory watching paused (no file change notifications). On restore, directory re-read and watching resumed
      Verify: `pnpm test -- --run --grep "watch-visibility-minimize"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Watcher error (permission revoked mid-watch): log error, degrade to manual refresh
- Rapid file changes (bulk operations): chokidar batches events, renderer debounces tree updates (100ms)
- Network drive: chokidar may not fire events; manual refresh available
- Sub-directory changes: depth: 0 means only direct children fire events, not nested changes

### R6: Save Scrollback

**ASR:** none
**Input:** "Save Scrollback" in terminal context menu (R13 of spec-1)
**Behavior:** SerializeAddon.serialize({ excludeModes: true, excludeAltBuffer: true }) extracts full scrollback buffer as plain text (no ANSI escape sequences). Text sent via electronAPI.scrollback.save(text). Main process opens dialog.showSaveDialog with filters: `[{ name: 'Text Files', extensions: ['txt'] }]`, defaultPath: `scrollback-{timestamp}.txt`. If user confirms, fs.writeFile writes UTF-8 text to chosen path. Returns { saved: true, path } or { saved: false } on cancel.
**Output:** Scrollback saved to user-chosen file, or cancelled
**Impact scope:**
- renderer/terminal: SerializeAddon integration (addition to TerminalView addons)
- renderer/components: ContextMenu "Save Scrollback" handler
- main/scrollback: ScrollbackService.saveScrollback
- main/ipc: scrollback:save handler
- preload/api: electronAPI.scrollback.save
**Acceptance criteria:**
- [ ] Given: Terminal with scrollback content
      When: "Save Scrollback" selected from context menu
      Then: Save dialog opens with plain text file type filter and default filename
      Verify: `pnpm test:e2e -- --grep "scrollback-save-dialog"`
      Verify-type: e2e
      Automatable: true
- [ ] Given: Save dialog confirmed with path
      When: File written
      Then: Plain text file created at path, content matches scrollback buffer (no ANSI escapes)
      Verify: `pnpm test -- --run --grep "scrollback-save-content"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Save dialog cancelled
      When: User clicks Cancel
      Then: No file created, operation reports cancellation
      Verify: `pnpm test -- --run --grep "scrollback-save-cancel"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Empty scrollback (fresh terminal): save empty file (valid use case)
- Write failure (disk full, permission): rejected Promise, error displayed to user
- Very large scrollback (20K lines): serialize may take >100ms, show brief loading indicator

### R7: Custom File Protocol

**ASR:** ASR-11, ASR-12
**Input:** Renderer requests `ezterm-file://{absolutePath}`
**Behavior:** Registered at app.whenReady via protocol.handle('ezterm-file'). Handler:
1. Parse requested path from URL
2. Resolve symlinks via fs.realpath
3. Validate extension against whitelist: image (.png, .jpg, .jpeg, .gif, .bmp, .webp, .svg) or HTML (.html, .htm)
4. If extension not in whitelist: return 403 response
5. If path traversal detected (.. after resolve differs from before): return 403
6. Read file, return with correct MIME type
**Output:** File content served to renderer
**Impact scope:**
- main/protocol: registerEztermFileProtocol
- main/index.ts: protocol registration at app ready (Stage 0)
**Acceptance criteria:**
- [ ] Given: Custom protocol request for a valid image file path
      When: Protocol handler processes the request
      Then: Image bytes returned with correct MIME type
      Verify: `pnpm test -- --run --grep "protocol-image-serve"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Custom protocol request for a non-whitelisted file type
      When: Protocol handler checks extension
      Then: 403 forbidden response returned
      Verify: `pnpm test -- --run --grep "protocol-extension-deny"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Custom protocol request with path traversal segments
      When: Resolved path differs from original path
      Then: 403 forbidden response returned
      Verify: `pnpm test -- --run --grep "protocol-traversal-deny"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Custom protocol request for a valid HTML file path
      When: Protocol handler processes the request
      Then: HTML content returned with correct MIME type
      Verify: `pnpm test -- --run --grep "protocol-html-serve"`
      Verify-type: lib
      Automatable: true
**Edge cases:**
- Symlink to file outside expected scope: resolved path is validated, symlink itself is not blocked
- File not found: 404 response
- Very large image file: streamed directly, no size limit (renderer handles display)

### R8: Preload API Extension

**ASR:** ASR-8
**Input:** Renderer code calls electronAPI.fs.* or electronAPI.scrollback.*
**Behavior:** Extend ElectronAPI interface and contextBridge implementation:
```typescript
fs: {
  readdir: (dirPath: string) => ipcRenderer.invoke('fs:readdir', dirPath),
  readPreview: (filePath: string) => ipcRenderer.invoke('fs:readPreview', filePath),
  getCwd: (sessionId: string) => ipcRenderer.invoke('fs:getCwd', sessionId),
  watchDir: (dirPath: string) => ipcRenderer.invoke('fs:watchDir', dirPath),
  unwatchDir: (dirPath: string) => ipcRenderer.invoke('fs:unwatchDir', dirPath),
  onChanged: (cb: (event: FsChangeEvent) => void) => {
    const handler = (_e: IpcRendererEvent, event: FsChangeEvent) => cb(event);
    ipcRenderer.on('fs:changed', handler);
    return () => ipcRenderer.removeListener('fs:changed', handler);
  },
},
scrollback: {
  save: (text: string) => ipcRenderer.invoke('scrollback:save', text),
}
```
No Node.js modules exposed to renderer. All access through typed IPC.
**Output:** Typed API available on window.electronAPI
**Impact scope:**
- preload/api: ElectronAPI interface extension, contextBridge implementation
**Acceptance criteria:**
- [ ] Given: Renderer code calls filesystem directory listing API
      When: Request sent through preload bridge
      Then: Main process handles request and returns typed directory entries
      Verify: `pnpm test -- --run --grep "preload-fs-api"`
      Verify-type: lib
      Automatable: true
- [ ] Given: Renderer source directory
      When: Source files scanned for Node.js built-in module imports
      Then: No Node.js module imports found
      Verify: `bash -c '! grep -rE "require\(.(fs|path|child_process)" src/renderer/'`
      Verify-type: cli
      Automatable: true
**Edge cases:**
- electronAPI.fs.onChanged cleanup: returned unsubscribe function must remove listener to prevent memory leak

## Cross-Reference: spec-1 Updates

This spec supersedes the following items in spec-1 (2026-05-15-terminal-shell-design.md):

- **R12 (Rail Panel System):** "Files (disabled/future)" is now active. Files icon opens FilesPanel (lazy creation, same as Status/Network/Settings). uiSlice.activePanel accepts 'files' value. Edge case "Files icon: shows disabled tooltip, no panel opened" is removed.
- **R13 (Context Menu):** "Save Scrollback" menu item behavior is now defined by R6 of this spec. R13's acceptance criteria remain for menu rendering; Save Scrollback execution is verified by R6 AC.
- **WM-REG4:** @xterm/addon-serialize added to xterm.js addon list (alongside WebGL, Fit, Unicode11, Search).
