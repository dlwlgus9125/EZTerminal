import { forwardRef, type HTMLAttributes } from 'react';

import { classNames } from './utils';

export type VisuallyHiddenProps = HTMLAttributes<HTMLSpanElement>;

export const VisuallyHidden = forwardRef<HTMLSpanElement, VisuallyHiddenProps>(function VisuallyHidden(
  { className, ...props },
  ref,
) {
  return <span ref={ref} className={classNames('ez-ui-visually-hidden', className)} {...props} />;
});
