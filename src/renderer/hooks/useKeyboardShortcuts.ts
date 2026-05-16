/**
 * useKeyboardShortcuts — T6 scope.
 * Global keyboard shortcuts for tab and pane management.
 *
 * Tab shortcuts (window-level):
 *   Ctrl+T        → create new tab
 *   Ctrl+W        → close active tab (blocked if last)
 *   Ctrl+Tab      → switch to next tab
 *
 * Pane shortcuts (via xterm customKeyEventHandler — see TerminalView):
 *   Ctrl+Shift+D  → split active pane right (horizontal)
 *   Ctrl+Shift+E  → split active pane down (vertical)
 *   Ctrl+Shift+W  → close active pane (blocked if last)
 *   Ctrl+Alt+ArrowLeft/Right/Up/Down → focus adjacent pane (cycles through pane list)
 */

import { useEffect } from "react";
import { useStore } from "../store";

export function useKeyboardShortcuts(): void {
  const activeTabId = useStore((s) => s.activeTabId);
  const tabs = useStore((s) => s.tabs);
  const addTab = useStore((s) => s.addTab);
  const closeTab = useStore((s) => s.closeTab);
  const switchTab = useStore((s) => s.switchTab);
  const splitPane = useStore((s) => s.splitPane);
  const closePane = useStore((s) => s.closePane);
  const focusPane = useStore((s) => s.focusPane);
  const getPaneIds = useStore((s) => s.getPaneIds);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      const tabId = activeTabId;
      if (!tabId) return;

      const tab = tabs[tabId];
      const activePaneId = tab?.activePaneId ?? null;

      // ── Tab shortcuts ──────────────────────────────────────────────────────

      // Ctrl+T → new tab
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "t") {
        e.preventDefault();
        addTab();
        return;
      }

      // Ctrl+W (no shift, no alt) → close active tab
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "w") {
        e.preventDefault();
        closeTab(tabId);
        return;
      }

      // Ctrl+Tab → next tab
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "Tab") {
        e.preventDefault();
        const tabIds = Object.keys(tabs);
        const currentIdx = tabIds.indexOf(tabId);
        const nextIdx = (currentIdx + 1) % tabIds.length;
        const nextId = tabIds[nextIdx];
        if (nextId && nextId !== tabId) switchTab(nextId);
        return;
      }

      // ── Pane shortcuts ─────────────────────────────────────────────────────

      if (!activePaneId) return;

      // Ctrl+Shift+D → split right (horizontal)
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.key === "D") {
        e.preventDefault();
        splitPane(tabId, activePaneId, "horizontal");
        return;
      }

      // Ctrl+Shift+E → split down (vertical)
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.key === "E") {
        e.preventDefault();
        splitPane(tabId, activePaneId, "vertical");
        return;
      }

      // Ctrl+Shift+W → close active pane
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.key === "W") {
        e.preventDefault();
        closePane(tabId, activePaneId);
        return;
      }

      // Ctrl+Alt+Arrow → cycle focus through panes
      if (e.ctrlKey && !e.shiftKey && e.altKey) {
        if (
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight" ||
          e.key === "ArrowUp" ||
          e.key === "ArrowDown"
        ) {
          e.preventDefault();
          const paneIds = getPaneIds(tabId);
          if (paneIds.length <= 1) return;
          const currentIdx = paneIds.indexOf(activePaneId);
          let nextIdx: number;
          if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
            nextIdx = (currentIdx - 1 + paneIds.length) % paneIds.length;
          } else {
            nextIdx = (currentIdx + 1) % paneIds.length;
          }
          const nextPaneId = paneIds[nextIdx];
          if (nextPaneId) focusPane(tabId, nextPaneId);
          return;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [activeTabId, tabs, addTab, closeTab, switchTab, splitPane, closePane, focusPane, getPaneIds]);
}
