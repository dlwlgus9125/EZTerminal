import { memo, useEffect, useState, useTransition } from 'react';

import { Input } from './ui';

export interface DeferredSearchInputProps {
  readonly value: string;
  readonly onQueryChange: (value: string) => void;
  readonly type?: 'search' | 'text';
  readonly variant?: 'ui' | 'native';
  readonly className?: string;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly testId?: string;
}

/** Keeps the browser-controlled keystroke commit urgent and ranks results concurrently. */
export const DeferredSearchInput = memo(function DeferredSearchInput({
  value,
  onQueryChange,
  type = 'search',
  variant = 'native',
  className,
  placeholder,
  ariaLabel,
  testId,
}: DeferredSearchInputProps): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [, startTransition] = useTransition();

  useEffect(() => setDraft(value), [value]);

  const props = {
    type,
    value: draft,
    className,
    placeholder,
    'aria-label': ariaLabel,
    'data-testid': testId,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = event.currentTarget.value;
      setDraft(next);
      startTransition(() => onQueryChange(next));
    },
  };

  return variant === 'ui' ? <Input {...props} /> : <input {...props} />;
});
