import { ChevronDown } from 'lucide-react';
import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

import { classNames } from './utils';

interface FieldContextValue {
  readonly controlId: string;
  readonly descriptionId?: string;
  readonly errorId?: string;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export interface FieldProps extends Omit<HTMLAttributes<HTMLDivElement>, 'id'> {
  readonly id?: string;
  readonly label: ReactNode;
  readonly labelHidden?: boolean;
  readonly description?: ReactNode;
  readonly error?: ReactNode;
  readonly required?: boolean;
  readonly disabled?: boolean;
}

export const Field = forwardRef<HTMLDivElement, FieldProps>(function Field(
  {
    children,
    className,
    description,
    disabled = false,
    error,
    id: idProp,
    label,
    labelHidden = false,
    required = false,
    ...props
  },
  ref,
) {
  const generatedId = useId();
  const controlId = idProp ?? `ez-ui-field-${generatedId}`;
  const descriptionId = description ? `${controlId}-description` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const context: FieldContextValue = {
    controlId,
    descriptionId,
    errorId,
    disabled,
    invalid: Boolean(error),
    required,
  };

  return (
    <FieldContext.Provider value={context}>
      <div
        ref={ref}
        className={classNames('ez-ui-field', className)}
        data-disabled={disabled || undefined}
        data-invalid={Boolean(error) || undefined}
        {...props}
      >
        <label
          className={classNames('ez-ui-field__label', labelHidden && 'ez-ui-visually-hidden')}
          htmlFor={controlId}
        >
          {label}
          {required && (
            <span className="ez-ui-field__required" aria-hidden="true">
              *
            </span>
          )}
        </label>
        {children}
        {description && !error && (
          <div id={descriptionId} className="ez-ui-field__description">
            {description}
          </div>
        )}
        {error && (
          <div id={errorId} className="ez-ui-field__error" role="alert">
            {error}
          </div>
        )}
      </div>
    </FieldContext.Provider>
  );
});

function useFieldControl(
  id: string | undefined,
  describedBy: string | undefined,
): {
  id: string | undefined;
  describedBy: string | undefined;
  disabled: boolean | undefined;
  invalid: boolean | undefined;
  required: boolean | undefined;
} {
  const field = useContext(FieldContext);
  const fieldDescription = field?.errorId ?? field?.descriptionId;
  const mergedDescription = [describedBy, fieldDescription].filter(Boolean).join(' ') || undefined;
  return {
    id: id ?? field?.controlId,
    describedBy: mergedDescription,
    disabled: field?.disabled || undefined,
    invalid: field?.invalid || undefined,
    required: field?.required || undefined,
  };
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly uiSize?: 'sm' | 'md' | 'lg';
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    className,
    disabled,
    id,
    required,
    uiSize = 'md',
    ...props
  },
  ref,
) {
  const field = useFieldControl(id, ariaDescribedBy);
  return (
    <input
      ref={ref}
      id={field.id}
      className={classNames('ez-ui-input', className)}
      data-size={uiSize}
      disabled={disabled || field.disabled}
      required={required || field.required}
      aria-invalid={ariaInvalid ?? field.invalid}
      aria-describedby={field.describedBy}
      {...props}
    />
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly uiSize?: 'sm' | 'md' | 'lg';
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    children,
    className,
    disabled,
    id,
    required,
    uiSize = 'md',
    ...props
  },
  ref,
) {
  const field = useFieldControl(id, ariaDescribedBy);
  const isDisabled = disabled || field.disabled;
  return (
    <span className="ez-ui-select-shell" data-disabled={isDisabled || undefined} data-size={uiSize}>
      <select
        ref={ref}
        id={field.id}
        className={classNames('ez-ui-select', className)}
        disabled={isDisabled}
        required={required || field.required}
        aria-invalid={ariaInvalid ?? field.invalid}
        aria-describedby={field.describedBy}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="ez-ui-select-shell__icon" aria-hidden="true" />
    </span>
  );
});

export interface SwitchProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'children' | 'type' | 'size'> {
  readonly label: ReactNode;
  readonly description?: ReactNode;
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { className, description, disabled = false, id: idProp, label, ...props },
  ref,
) {
  const generatedId = useId();
  const id = idProp ?? `ez-ui-switch-${generatedId}`;
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <label className={classNames('ez-ui-switch', className)} data-disabled={disabled || undefined} htmlFor={id}>
      <input
        ref={ref}
        {...props}
        id={id}
        type="checkbox"
        role="switch"
        className="ez-ui-switch__input"
        disabled={disabled}
        aria-describedby={descriptionId}
      />
      <span className="ez-ui-switch__track" aria-hidden="true">
        <span className="ez-ui-switch__thumb" />
      </span>
      <span className="ez-ui-switch__copy">
        <span className="ez-ui-switch__label">{label}</span>
        {description && (
          <span id={descriptionId} className="ez-ui-switch__description">
            {description}
          </span>
        )}
      </span>
    </label>
  );
});
