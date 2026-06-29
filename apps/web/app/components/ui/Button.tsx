// components/ui/Button.tsx — HIG-spec button primitive.
//
// Variants / sizes encoded via `class-variance-authority` (`cva`).
// Every icon-only button MUST have an `aria-label` — we surface that
// as a TS-level requirement at the consumer boundary by exporting a
// discriminated union for the props.
//
// Spec section 2.1: three variants (primary / secondary / tertiary) +
// destructive. Sizes: sm 32pt, md 40pt, lg 48pt, icon 44x44pt
// (HIG minimum touch target). Default radius 10px (NOT Material
// You 28pt+ corners). 44x44 touch target via padding.
//
// No raw colors / sizes / easings — all references go through the
// design system tokens (apps/web/app/styles/tokens.css via
// tailwind.config.ts mappings).

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

const buttonVariants = cva(
  // Base — applies to all variants.
  'inline-flex items-center justify-center font-medium ' +
    'transition-colors duration-fast ease-out ' +
    'focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-accent focus-visible:ring-offset-2 ' +
    'disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none ' +
    'active:scale-[0.97] transition-transform',
  {
    variants: {
      variant: {
        // Primary uses the school's accent color (set via --color-accent).
        primary: 'bg-accent text-on-accent hover:opacity-90',
        secondary:
          'bg-surface text-primary border border-border hover:bg-surface-2',
        tertiary:
          'bg-transparent text-accent hover:bg-accent-soft',
        destructive:
          'bg-error text-on-accent hover:opacity-90',
      },
      size: {
        sm: 'h-btn-sm px-md text-footnote rounded-sm',
        md: 'h-btn-md px-lg text-body rounded-md',
        lg: 'h-btn-lg px-xl text-body-em rounded-md',
        // Icon-only — fixed 44x44pt square (HIG minimum touch target).
        icon: 'h-tabbar w-tabbar p-0 rounded-md',
        'icon-sm': 'h-btn-md w-btn-md p-0 rounded-md',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export type ButtonVariantProps = VariantProps<typeof buttonVariants>;

type BaseProps = ButtonHTMLAttributes<HTMLButtonElement> & ButtonVariantProps;

export type ButtonProps =
  | (BaseProps & { 'aria-label': string; size?: 'icon' | 'icon-sm' })
  | (BaseProps & { size?: Exclude<NonNullable<ButtonVariantProps['size']>, 'icon' | 'icon-sm'> });

/**
 * Buttons are the primary call to action. Use `variant` for color,
 * `size` for height / padding. Icon-only buttons are restricted to
 * the `icon*` size and require `aria-label`.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type = 'button', ...rest },
  ref,
) {
  // Only override the size union when the caller passed one — we
  // don't want to bind "icon" as the default even when the type
  // discriminated branch did.
  const computedSize =
    variant && /icon/.test(String(size ?? '')) ? size : size;
  return (
    <button
      ref={ref}
      type={type}
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size: computedSize }), className)}
      {...rest}
    />
  );
});

/**
 * Re-export of the variants for callers that want to mirror the button
 * look on a non-button element (e.g. an `<a>` styled like a button).
 */
export const buttonClassName = buttonVariants;
