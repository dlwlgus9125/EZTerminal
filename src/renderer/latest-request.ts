import { useEffect, useRef } from 'react';

export interface LatestRequestGate {
  begin(): number;
  isCurrent(generation: number): boolean;
  invalidate(): void;
}

/**
 * Guards renderer-owned async reads whose transport cannot always be aborted.
 * Only the most recently started generation may commit UI state.
 */
export function createLatestRequestGate(): LatestRequestGate {
  let current = 0;
  return Object.freeze({
    begin: () => {
      current += 1;
      return current;
    },
    isCurrent: (generation: number) => generation === current,
    invalidate: () => {
      current += 1;
    },
  });
}

export function useLatestRequestGate(): LatestRequestGate {
  const gateRef = useRef<LatestRequestGate | null>(null);
  if (gateRef.current === null) gateRef.current = createLatestRequestGate();
  useEffect(() => () => gateRef.current?.invalidate(), []);
  return gateRef.current;
}
