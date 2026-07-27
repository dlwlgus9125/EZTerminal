/**
 * The three-bar EZTerminal signal mark. Code-native by contract (frontend
 * design spec 3.1) — never a raster asset, so it re-tints with the theme's
 * accent role and stays crisp at any density.
 */
export function MobileSignalMark({ size = 'sm' }: { readonly size?: 'sm' | 'lg' }): JSX.Element {
  return (
    <span className={size === 'lg' ? 'mob-mark mob-mark--lg' : 'mob-mark'} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}
