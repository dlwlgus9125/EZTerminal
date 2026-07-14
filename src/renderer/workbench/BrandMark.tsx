export interface BrandMarkProps {
  readonly className?: string;
}

/**
 * Code-native product signature. The signal mark is decorative while the
 * visible wordmark provides the accessible heading name at every desktop
 * breakpoint.
 */
export function BrandMark({ className }: BrandMarkProps): JSX.Element {
  const classes = ['workbench-brand-mark', className].filter(Boolean).join(' ');

  return (
    <h1 className={classes} data-testid="workbench-brand-mark">
      <span className="workbench-brand-mark__signal" aria-hidden="true">
        <span className="workbench-brand-mark__signal-bar" />
        <span className="workbench-brand-mark__signal-bar" />
        <span className="workbench-brand-mark__signal-bar" />
      </span>
      <span className="workbench-brand-mark__name">EZTerminal</span>
    </h1>
  );
}
