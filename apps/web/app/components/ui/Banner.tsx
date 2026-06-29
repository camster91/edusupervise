// components/ui/Banner.tsx — transient alert banner.
//
// Spec section 2.8. Replaces the "red wall" pattern with a top-of-
// screen transient banner. One at a time, max. Never modal. Never
// blocks input. Auto-dismisses after `durationMs` (default 8s).
//
// Used for: conflict alerts ("you have two duties at 11:30"),
// coverage status, info messages, transient errors.

import { useEffect, useState, type ReactNode } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Info,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/cn';

export type BannerVariant = 'info' | 'success' | 'warning' | 'error';

const variantConfig: Record<
  BannerVariant,
  { Icon: LucideIcon; bg: string; fg: string }
> = {
  info:    { Icon: Info,           bg: 'bg-info',    fg: 'text-on-accent' },
  success: { Icon: CheckCircle2,   bg: 'bg-success', fg: 'text-on-accent' },
  warning: { Icon: AlertTriangle,  bg: 'bg-warning', fg: 'text-on-accent' },
  error:   { Icon: AlertCircle,    bg: 'bg-error',   fg: 'text-on-accent' },
};

export interface BannerProps {
  variant?: BannerVariant;
  /** Banner body — keep under 140 chars. */
  message: string;
  /** Optional inline action (button) shown to the right of the message. */
  action?: {
    label: string;
    onClick: () => void;
  };
  /** Auto-dismiss after N ms. Set to 0 to disable. Default 8000. */
  durationMs?: number;
  /** Optional dismiss handler. If provided, an X button appears. */
  onDismiss?: () => void;
  className?: string;
}

/**
 * Banner is a self-dismissing alert. Mount it from a route's loader
 * error or from a `toast()` call. The container is responsible for
 * positioning (typically a stack at the top of the screen with 16px
 * from the safe area).
 *
 * Accessibility:
 *  - role="status" + aria-live="polite" for info/success
 *  - role="alert" + aria-live="assertive" for warning/error
 */
export function Banner({
  variant = 'info',
  message,
  action,
  durationMs = 8000,
  onDismiss,
  className,
}: BannerProps): ReactNode {
  const [visible, setVisible] = useState(true);
  const { Icon, bg, fg } = variantConfig[variant];

  useEffect(() => {
    if (durationMs <= 0) return;
    const id = window.setTimeout(() => {
      setVisible(false);
      onDismiss?.();
    }, durationMs);
    return () => window.clearTimeout(id);
  }, [durationMs, onDismiss]);

  if (!visible) return null;

  const isAssertive = variant === 'warning' || variant === 'error';

  return (
    <div
      role={isAssertive ? 'alert' : 'status'}
      aria-live={isAssertive ? 'assertive' : 'polite'}
      className={cn(
        'flex items-center gap-md',
        'px-lg py-md',
        'rounded-md shadow-elev-2',
        bg, fg,
        'animate-[slideDown_250ms_var(--ease-out)]',
        className,
      )}
    >
      <Icon size={20} aria-hidden className="shrink-0" />
      <p className="flex-1 text-callout">{message}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className={cn(
            'shrink-0 px-sm py-xs rounded-sm',
            'underline underline-offset-2',
            'hover:bg-surface hover:text-primary',
            'transition-colors duration-fast',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-on-accent',
          )}
        >
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={() => {
            setVisible(false);
            onDismiss();
          }}
          aria-label="Dismiss"
          className={cn(
            'shrink-0 h-btn-sm w-btn-sm rounded-sm',
            'inline-flex items-center justify-center',
            'hover:bg-surface hover:text-primary',
            'transition-colors duration-fast',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-on-accent',
          )}
        >
          <X size={16} aria-hidden />
        </button>
      )}
    </div>
  );
}

/**
 * Banner container that stacks multiple banners at the top of the
 * screen. Typically rendered once at the layout level, with banners
 * added by routes via a `useBanner()` hook (not in this PR).
 */
export function BannerStack({ children }: { children: ReactNode }): ReactNode {
  return (
    <div
      aria-live="polite"
      className="fixed top-0 left-0 right-0 z-50 flex flex-col gap-sm p-md pointer-events-none"
    >
      <div className="flex flex-col gap-sm max-w-md mx-auto pointer-events-auto">
        {children}
      </div>
    </div>
  );
}
