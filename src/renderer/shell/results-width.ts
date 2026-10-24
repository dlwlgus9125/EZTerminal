import { createContext, useContext } from 'react';

/**
 * Board + Desk "widen results" (approved prototype): the Results tab of a conversation can take
 * most of the dock while the work list folds into its strip; narrowing gives the room back.
 */
export interface ResultsWidth {
  readonly wide: boolean;
  readonly toggle: (ownerPanelId: string) => void;
  /** Back to normal (the widened Results left the main window). */
  readonly reset: () => void;
}

export const ResultsWidthContext = createContext<ResultsWidth | null>(null);

export function useResultsWidth(): ResultsWidth | null {
  return useContext(ResultsWidthContext);
}

/** Share of the dock width the Results group takes when widened, and back to when narrowed. */
export const RESULTS_WIDE_SHARE = 0.62;
export const RESULTS_NARROW_SHARE = 0.36;
