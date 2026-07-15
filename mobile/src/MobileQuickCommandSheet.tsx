import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAppTranslation } from "../../src/renderer/i18n";
import type { QuickCommand } from "../../src/shared/quick-command";
import { MobileActionSheet } from "./MobileActionSheet";
import type { RemoteQuickCommandsResult } from "./transport/ws-ezterminal";

export interface MobileQuickCommandSource {
  listRemoteQuickCommands(): Promise<RemoteQuickCommandsResult>;
}

type LoadState = "idle" | "loading" | "ready" | "error" | "offline";

function filterCommands(
  commands: readonly QuickCommand[],
  query: string,
): readonly QuickCommand[] {
  const needle = query.trim().normalize("NFC").toLocaleLowerCase();
  if (!needle) return commands;
  return commands.filter((command) =>
    `${command.name}\n${command.description ?? ""}\n${command.command}`
      .normalize("NFC")
      .toLocaleLowerCase()
      .includes(needle),
  );
}

/** Capability-gated mobile picker. Command text is held only while the sheet
 * is open and every Run requires a second, explicit preview confirmation. */
export function MobileQuickCommandSheet({
  source,
  supported,
  connected,
  active = true,
  insertDisabledReason,
  runDisabledReason,
  onInsert,
  onRun,
}: {
  readonly source: MobileQuickCommandSource;
  readonly supported: boolean;
  readonly connected: boolean;
  /** False while the owning terminal tab is preserved off-screen. */
  readonly active?: boolean;
  readonly insertDisabledReason?: string;
  readonly runDisabledReason?: string;
  readonly onInsert: (command: string) => void;
  readonly onRun: (command: string) => void;
}): JSX.Element | null {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [commands, setCommands] = useState<readonly QuickCommand[]>([]);
  const [query, setQuery] = useState("");
  const [confirmCommand, setConfirmCommand] = useState<QuickCommand | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const requestSequenceRef = useRef(0);

  const close = useCallback((): void => {
    requestSequenceRef.current += 1;
    setOpen(false);
    setLoadState("idle");
    setCommands([]);
    setQuery("");
    setConfirmCommand(null);
  }, []);

  // Terminal tabs stay mounted to preserve PTY/UI state. A sheet must not
  // stay mounted inside a display:none tab: it would remain the top modal
  // layer and make the newly active tab inert even though no dialog is shown.
  useLayoutEffect(() => {
    if (!active && open) close();
  }, [active, close, open]);

  const load = useCallback((): void => {
    if (!connected) {
      setLoadState("offline");
      return;
    }
    requestSequenceRef.current += 1;
    const sequence = requestSequenceRef.current;
    setLoadState("loading");
    void source
      .listRemoteQuickCommands()
      .then((result) => {
        if (sequence !== requestSequenceRef.current) return;
        if (result.ok) {
          setCommands(result.commands);
          setLoadState("ready");
        } else {
          setCommands([]);
          setLoadState(result.error === "offline" ? "offline" : "error");
        }
      })
      .catch(() => {
        if (sequence === requestSequenceRef.current) {
          setCommands([]);
          setLoadState("error");
        }
      });
  }, [connected, source]);

  useEffect(() => {
    if (!open) return;
    load();
  }, [connected, load, open]);

  const visibleCommands = useMemo(
    () => filterCommands(commands, query),
    [commands, query],
  );

  if (!supported) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn mobile-quick-command-trigger"
        aria-label={t("mobile.quickCommands.title")}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="mobile-quick-command-trigger"
        onClick={() => setOpen(true)}
      >
        &gt;_
      </button>

      {active && open && (
        <MobileActionSheet
          title={
            confirmCommand
              ? t("mobile.quickCommands.runTitle")
              : t("mobile.quickCommands.title")
          }
          onClose={close}
          returnFocusRef={triggerRef}
          testId="mobile-quick-command-sheet"
        >
          {confirmCommand ? (
            <>
              <div className="mobile-quick-command-preview">
                <strong>{confirmCommand.name}</strong>
                <code>{confirmCommand.command}</code>
                <p>{t("mobile.quickCommands.confirmDescription")}</p>
              </div>
              <button
                type="button"
                className="mobile-action-sheet-row mobile-quick-command-confirm"
                disabled={!connected || Boolean(runDisabledReason)}
                title={!connected ? t("state.offline") : runDisabledReason}
                data-testid="mobile-quick-command-confirm-run"
                onClick={() => {
                  onRun(confirmCommand.command);
                  close();
                }}
              >
                <span className="mobile-action-sheet-row-label">
                  {t("mobile.quickCommands.runCommand")}
                </span>
                {!connected && (
                  <span className="mobile-action-sheet-row-state">
                    {t("state.offline")}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="mobile-action-sheet-row"
                onClick={() => setConfirmCommand(null)}
              >
                <span className="mobile-action-sheet-row-label">
                  {t("mobile.quickCommands.backToCommands")}
                </span>
              </button>
            </>
          ) : (
            <>
              <label className="mobile-quick-command-search-label">
                <span className="sr-only">
                  {t("mobile.quickCommands.searchLabel")}
                </span>
                <input
                  type="search"
                  className="mobile-quick-command-search"
                  value={query}
                  placeholder={t("mobile.quickCommands.searchPlaceholder")}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>

              {loadState === "loading" && (
                <p className="mobile-quick-command-state" role="status">
                  {t("mobile.quickCommands.loading")}
                </p>
              )}
              {loadState === "offline" && (
                <p className="mobile-quick-command-state" role="status">
                  {t("mobile.quickCommands.offlineDescription")}
                </p>
              )}
              {loadState === "error" && (
                <div className="mobile-quick-command-state" role="alert">
                  <p>{t("mobile.quickCommands.loadFailed")}</p>
                  <button
                    type="button"
                    className="btn"
                    onClick={load}
                    disabled={!connected}
                  >
                    {t("common.retry")}
                  </button>
                </div>
              )}
              {loadState === "ready" && commands.length === 0 && (
                <p className="mobile-quick-command-state">
                  {t("mobile.quickCommands.empty")}
                </p>
              )}
              {loadState === "ready" &&
                commands.length > 0 &&
                visibleCommands.length === 0 && (
                  <p className="mobile-quick-command-state">
                    {t("mobile.quickCommands.noMatches")}
                  </p>
                )}

              {visibleCommands.map((command) => (
                <div key={command.id} className="mobile-quick-command-row">
                  <button
                    type="button"
                    className="mobile-quick-command-insert"
                    disabled={Boolean(insertDisabledReason)}
                    title={
                      insertDisabledReason ??
                      t("mobile.quickCommands.insertNamed", {
                        name: command.name,
                      })
                    }
                    data-testid={`mobile-quick-command-insert-${command.id}`}
                    onClick={() => {
                      onInsert(command.command);
                      close();
                    }}
                  >
                    <strong>{command.name}</strong>
                    <code>{command.command}</code>
                    {command.description && <span>{command.description}</span>}
                  </button>
                  <button
                    type="button"
                    className="btn mobile-quick-command-run"
                    disabled={!connected || Boolean(runDisabledReason)}
                    title={
                      !connected
                        ? t("state.offline")
                        : (runDisabledReason ??
                          t("mobile.quickCommands.previewRunNamed", {
                            name: command.name,
                          }))
                    }
                    data-testid={`mobile-quick-command-run-${command.id}`}
                    onClick={() => setConfirmCommand(command)}
                  >
                    {t("mobile.quickCommands.run")}
                  </button>
                </div>
              ))}
            </>
          )}
        </MobileActionSheet>
      )}
    </>
  );
}
