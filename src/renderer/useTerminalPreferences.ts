import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DEFAULT_TERMINAL_PASTE_PREFERENCES,
  type TerminalPastePreferences,
  type TerminalPasteRisk,
} from '../shared/terminal-clipboard';

import { getActiveAppDocument } from './desktop-window-registry';

interface PendingPasteConfirmation {
  readonly risk: TerminalPasteRisk;
  readonly ownerDocument: Document;
  readonly resolve: (confirmed: boolean) => void;
}

export function useTerminalPreferences() {
  const [confirmRiskyPaneClose, setConfirmRiskyPaneClose] = useState(true);
  useEffect(() => {
    let alive = true;
    void window.ezterminalDesktop?.getConfirmRiskyPaneClose().then((enabled) => {
      if (alive) setConfirmRiskyPaneClose(enabled);
    });
    return () => {
      alive = false;
    };
  }, []);
  const changeConfirmRiskyPaneClose = useCallback((enabled: boolean): void => {
    setConfirmRiskyPaneClose(enabled);
    void window.ezterminalDesktop?.setConfirmRiskyPaneClose(enabled);
  }, []);
  const [bootIntro, setBootIntro] = useState(true);
  useEffect(() => {
    let alive = true;
    void window.ezterminalDesktop?.getBootIntro().then((enabled) => {
      if (alive) setBootIntro(enabled);
    });
    return () => {
      alive = false;
    };
  }, []);
  const changeBootIntro = useCallback((enabled: boolean): void => {
    setBootIntro(enabled);
    void window.ezterminalDesktop?.setBootIntro(enabled);
  }, []);
  const [allowOsc52Clipboard, setAllowOsc52Clipboard] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.ezterminalDesktop?.getAllowOsc52Clipboard().then((enabled) => {
      if (alive) setAllowOsc52Clipboard(enabled);
    });
    return () => {
      alive = false;
    };
  }, []);
  const changeAllowOsc52Clipboard = useCallback((enabled: boolean): void => {
    setAllowOsc52Clipboard(enabled);
    void window.ezterminalDesktop?.setAllowOsc52Clipboard(enabled);
  }, []);
  const [terminalPastePreferences, setTerminalPastePreferences] = useState<TerminalPastePreferences>(
    DEFAULT_TERMINAL_PASTE_PREFERENCES,
  );
  useEffect(() => {
    let alive = true;
    void window.ezterminalDesktop?.getTerminalPastePreferences().then((preferences) => {
      if (alive) setTerminalPastePreferences(preferences);
    });
    return () => {
      alive = false;
    };
  }, []);
  const changeTerminalPastePreferences = useCallback((preferences: TerminalPastePreferences): void => {
    setTerminalPastePreferences(preferences);
    void window.ezterminalDesktop?.setTerminalPastePreferences(preferences);
  }, []);
  const pendingPasteConfirmationRef = useRef<PendingPasteConfirmation | null>(null);
  const [pendingPasteConfirmation, setPendingPasteConfirmation] = useState<PendingPasteConfirmation | null>(null);
  const requestPasteConfirmation = useCallback((
    risk: TerminalPasteRisk,
    ownerDocument: Document = getActiveAppDocument(),
  ): Promise<boolean> => {
    if (pendingPasteConfirmationRef.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const pending = { risk, ownerDocument, resolve };
      pendingPasteConfirmationRef.current = pending;
      setPendingPasteConfirmation(pending);
    });
  }, []);
  const settlePasteConfirmation = useCallback((confirmed: boolean): void => {
    const pending = pendingPasteConfirmationRef.current;
    if (!pending) return;
    pendingPasteConfirmationRef.current = null;
    setPendingPasteConfirmation(null);
    pending.resolve(confirmed);
  }, []);
  useEffect(() => () => {
    const pending = pendingPasteConfirmationRef.current;
    pendingPasteConfirmationRef.current = null;
    pending?.resolve(false);
  }, []);

  return {
    confirmRiskyPaneClose,
    allowOsc52Clipboard,
    terminalPastePreferences,
    requestPasteConfirmation,
    changeConfirmRiskyPaneClose,
    bootIntro,
    changeBootIntro,
    changeAllowOsc52Clipboard,
    changeTerminalPastePreferences,
    pendingPasteConfirmation,
    settlePasteConfirmation,
  };
}
