export interface ChromeBand {
  readonly element: string;
  readonly testid?: string;
  readonly top: number;
  readonly height: number;
  readonly text: string;
}

export interface ChromeBands {
  readonly window: { readonly width: number; readonly height: number; readonly devicePixelRatio: number };
  readonly transcript: { readonly top: number; readonly bottom: number; readonly height: number; readonly width: number };
  readonly transcriptShare: number;
  readonly chromeAbovePx: number;
  readonly chromeBelowPx: number;
  readonly above: readonly ChromeBand[];
  readonly below: readonly ChromeBand[];
}

/** Bands stacked above and below the visible chat transcript, or null without one. */
export function measureChromeBands(): ChromeBands | null;
