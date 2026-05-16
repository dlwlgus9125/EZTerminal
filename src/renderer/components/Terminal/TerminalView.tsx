/**
 * TerminalView — T1+T2 scope.
 * Mounts xterm.js, wires PTY create/data/write IPC.
 * T2 additions:
 * - WebGL addon (with Canvas fallback on WebGL failure)
 * - FitAddon (fit on mount)
 * - Phosphor theme
 * - Full unmount cleanup (dispose terminal + addons)
 * - Zero-size container guard
 */

import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { type ReactElement, useEffect, useRef, useState } from "react";
import styles from "./TerminalView.module.css";

/** Phosphor terminal theme — dark green phosphor palette */
const PHOSPHOR_THEME = {
  background: "#0a0d0c",
  foreground: "#33ff33",
  cursor: "#33ff33",
  cursorAccent: "#0a0d0c",
  black: "#0a0d0c",
  red: "#ff3333",
  green: "#33ff33",
  yellow: "#ffff33",
  blue: "#3399ff",
  magenta: "#ff33ff",
  cyan: "#33ffff",
  white: "#d4d4d4",
  brightBlack: "#333333",
  brightRed: "#ff6666",
  brightGreen: "#66ff66",
  brightYellow: "#ffff66",
  brightBlue: "#66bbff",
  brightMagenta: "#ff66ff",
  brightCyan: "#66ffff",
  brightWhite: "#ffffff",
};

interface TerminalViewProps {
  /** Pre-existing session ID. If null, a new session will be created on mount. */
  sessionId: string | null;
}

export function TerminalView({ sessionId: initialSessionId }: TerminalViewProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialSessionId);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once effect; initialSessionId captured via closure
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Create xterm Terminal instance with Phosphor theme
    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      fontSize: 14,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      theme: PHOSPHOR_THEME,
    });
    terminalRef.current = terminal;

    // FitAddon — must be loaded before open
    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    terminal.loadAddon(fitAddon);

    // WebGL addon — with Canvas fallback on failure
    try {
      const webglAddon = new WebglAddon();
      webglAddonRef.current = webglAddon;
      terminal.loadAddon(webglAddon);
    } catch {
      // WebGL unavailable — xterm falls back to DOM/Canvas renderer automatically
      console.log("[TerminalView] WebGL unavailable, using Canvas renderer");
      webglAddonRef.current = null;
    }

    terminal.open(container);

    // Expose xterm instance for e2e test access (buffer API for WebGL-compatible text reading)
    (window as unknown as { __xterm__?: Terminal }).__xterm__ = terminal;

    // Fit to container size (guard for zero-size)
    try {
      fitAddon.fit();
    } catch {
      // Container may have zero size in tests or before layout
    }

    let sessionId = initialSessionId;
    let unsubData: (() => void) | null = null;
    let unsubExit: (() => void) | null = null;

    async function initSession(): Promise<void> {
      if (!sessionId) {
        const result = await window.electronAPI.pty.create({ cols: 80, rows: 24 });
        if (!result.ok) {
          setErrorCode(result.code);
          return;
        }
        sessionId = result.data;
        setActiveSessionId(sessionId);
      }

      // Receive PTY output → write to xterm
      unsubData = window.electronAPI.pty.onData(sessionId, (data) => {
        terminal.write(data);
      });

      // PTY exit
      unsubExit = window.electronAPI.pty.onExit(sessionId, (code) => {
        console.log(`[TerminalView] PTY exited code=${code}`);
      });

      // customKeyEventHandler — intercept shortcuts before xterm processes them.
      // Ctrl+C: send SIGINT (\x03) to PTY and suppress xterm's default.
      // Global tab/pane shortcuts (Ctrl+T/W/Tab, Ctrl+Shift+D/E/W, Ctrl+Alt+Arrow)
      // are handled by useKeyboardShortcuts at window level; return false here so
      // xterm does not also handle them, but the window listener still fires first.
      terminal.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        // Let keyup events through unmodified
        if (ev.type !== "keydown") return true;

        // Ctrl+C → send SIGINT to PTY (do not copy to clipboard)
        if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key === "c") {
          if (sessionId) {
            window.electronAPI.pty.write(sessionId, "\x03");
          }
          return false; // suppress xterm's own Ctrl+C handling
        }

        // Suppress xterm handling for global shortcuts handled by useKeyboardShortcuts
        // so they don't also produce PTY output.
        // Ctrl+T, Ctrl+W (no shift), Ctrl+Tab
        if (ev.ctrlKey && !ev.shiftKey && !ev.altKey) {
          if (ev.key === "t" || ev.key === "w" || ev.key === "Tab") return false;
        }
        // Ctrl+Shift+D/E/W
        if (ev.ctrlKey && ev.shiftKey && !ev.altKey) {
          if (ev.key === "D" || ev.key === "E" || ev.key === "W") return false;
        }
        // Ctrl+Alt+Arrow
        if (ev.ctrlKey && !ev.shiftKey && ev.altKey) {
          if (
            ev.key === "ArrowLeft" ||
            ev.key === "ArrowRight" ||
            ev.key === "ArrowUp" ||
            ev.key === "ArrowDown"
          )
            return false;
        }

        // All other keys pass through to PTY via onData
        return true;
      });

      // User input → send to PTY
      terminal.onData((data: string) => {
        if (sessionId) {
          window.electronAPI.pty.write(sessionId, data);
        }
      });

      // Resize
      terminal.onResize(({ cols, rows }) => {
        if (sessionId) {
          window.electronAPI.pty.resize(sessionId, cols, rows);
        }
      });
    }

    initSession().catch((err: unknown) => {
      console.log("[TerminalView] initSession error:", err);
    });

    // Cleanup on unmount
    return () => {
      unsubData?.();
      unsubExit?.();
      webglAddonRef.current?.dispose();
      webglAddonRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  return (
    <div className={`${styles.terminalWrapper} terminal-wrapper`}>
      {errorCode && (
        <div className={styles.errorMessage} role="alert">
          PTY error: {errorCode}
        </div>
      )}
      <div ref={containerRef} className={styles.terminalContainer} />
    </div>
  );
}
