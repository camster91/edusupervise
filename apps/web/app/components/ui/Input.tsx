// components/ui/Input.tsx — text input + textarea + label + helper text.
//
// One module rather than three because Label / Input / Description
// form one cohesive form pattern. The labelled control pattern is
// the first recommendation of the WCAG form-guidelines section; a
// `<label>` is wired by both id + htmlFor and React's child
// relationship so screen-readers see the link.
//
// Spec section 9 lists Input as one of the Radix-wrapped UI
// primitives. There's no Radix Input (Radix ships TextField as a
// headless wrapper for non-text inputs); we follow the conventional
// label + control + description pattern with strict ARIA wiring.

import * as React from 'react';
import { cn } from '../../lib/cn';

// Idempotent id generator. Used by the Label → Input wiring so the
// control's accessibility attribute points at a unique element. We
// prefer `useId()` (React 18+) over a global counter so SSR + CSR
// agree on the id without hydration warnings.
let __idCounter = 0;
function fallbackId(prefix: string): string {
  __idCounter += 1;
  return `${prefix}-${__idCounter}`;
}

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Visible label. Rendered above the input. Required for a11y. */
  label: string;
  /** Optional helper text below the input. Sets `aria-describedby`. */
  description?: string;
  /** Optional error text — turns the input red and overrides `description`. */
  error?: string;
  /** Container class override (for outer layout only). */
  containerClassName?: string;
}

/**
 * `<input>` with label, optional description, and optional error.
 * `aria-invalid` flips to true on `error`; `aria-describedby` always
 * points at the description id (or the error id when error is set).
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input(
    { id, label, description, error, className, containerClassName, ...rest },
    ref,
  ) {
    const reactId = React.useId();
    const inputId = id ?? reactId ?? fallbackId('input');
    const descriptionId = `${inputId}-desc`;
    const errorId = `${inputId}-err`;
    const describedBy = error ? errorId : description ? descriptionId : undefined;
    return (
      <div className={cn('flex flex-col gap-1.5', containerClassName)}>
        <label
          htmlFor={inputId}
          className="text-body font-medium text-primary"
        >
          {label}
        </label>
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'block w-full px-3 py-2 bg-surface border rounded-md text-body',
            'focus:outline-none focus:ring-2 transition',
            error
              ? 'border-error focus:border-red-500 focus:ring-red-200'
              : 'border-border focus:border-accent focus:ring-accent/30',
            // Disable native-autofill yellow flash on Chrome
            'autofill:shadow-[inset_0_0_0_1000px_white]',
            className,
          )}
          {...rest}
        />
        {description && !error && (
          <p id={descriptionId} className="text-xs text-tertiary">
            {description}
          </p>
        )}
        {error && (
          <p id={errorId} className="text-xs text-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  },
);

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  description?: string;
  error?: string;
  containerClassName?: string;
}

/** Same accessibility wiring as `Input` but for multi-line text. */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(
    { id, label, description, error, className, containerClassName, ...rest },
    ref,
  ) {
    const reactId = React.useId();
    const inputId = id ?? reactId ?? fallbackId('textarea');
    const descriptionId = `${inputId}-desc`;
    const errorId = `${inputId}-err`;
    const describedBy = error ? errorId : description ? descriptionId : undefined;
    return (
      <div className={cn('flex flex-col gap-1.5', containerClassName)}>
        <label
          htmlFor={inputId}
          className="text-body font-medium text-primary"
        >
          {label}
        </label>
        <textarea
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'block w-full px-3 py-2 bg-surface border rounded-md text-body min-h-[80px]',
            'focus:outline-none focus:ring-2 transition',
            error
              ? 'border-error focus:border-red-500 focus:ring-red-200'
              : 'border-border focus:border-accent focus:ring-accent/30',
            className,
          )}
          {...rest}
        />
        {description && !error && (
          <p id={descriptionId} className="text-xs text-tertiary">
            {description}
          </p>
        )}
        {error && (
          <p id={errorId} className="text-xs text-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  },
);
