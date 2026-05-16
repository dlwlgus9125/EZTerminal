/**
 * TerminalView — T1 skeleton scope.
 * Mounts xterm.js, wires PTY create/data/write IPC.
 * WebGL addon NOT loaded (deferred to T2).
 * FitAddon loaded to handle container sizing.
 */

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { type ReactElement, useEffect, useRef, useState } from "react";
import styles from "./TerminalView.module.css";

interface TerminalViewProps {
  /** Pre-existing session ID. If null, a new session will be created on mount. */
  sessionId: string | null;
}

export function TerminalView({ sessionId: initialSessionId }: TerminalViewProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialSessionId);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once effect; initialSessionId captured via closure
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Create xterm Terminal instance
    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      fontSize: 14,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      theme: {
        background: "#0a0d0c",
        foreground: "#d4d4d4",
      },
    });
    terminalRef.current = terminal;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    terminal.loadAddon(fitAddon);
    terminal.open(container);

    let sessionId = initialSessionId;
    let unsubData: (() => void) | null = null;
    let unsubExit: (() => void) | null = null;

    async function initSession(): Promise<void> {
      if (!sessionId) {
        // Create a new PTY session
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

      // Fit to container
      try {
        fitAddon.fit();
      } catch {
        // Container may not have size yet
      }
    }

    initSession().catch((err: unknown) => {
      console.log("[TerminalView] initSession error:", err);
    });

    // Cleanup on unmount
    return () => {
      unsubData?.();
      unsubExit?.();
      terminal.dispose();
      terminalRef.current = null;
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
