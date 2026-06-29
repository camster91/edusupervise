// components/ui/EmptyState.tsx — three-job empty state pattern
// (NN/g guidance: communicate status, provide learning cue, give
// direct path to key task).
//
// Spec section 2.9. Used on every list / dashboard when there's no
// data yet. The action is optional but strongly recommended.

import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface EmptyStateProps {
  /** 48pt icon (lucide-react, etc.). Recommended but not required. */
  icon?: ReactNode;
  /** Short title — `--text-title-3`. */
  title: string;
  /** Body text — `--text-body`. Max 280 chars recommended. */
  description?: string;
  /** Optional primary action (rendered as a button). */
  action?: {
    label: string;
    onClick: () => void;
    href?: never;
  } | {
    label: string;
    href: string;
    onClick?: never;
  };
  /** Optional secondary action (rendered as a text link). */
  secondaryAction?: {
    label: string;
    onClick?: () => void;
    href?: string;
  };
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  className,
}: EmptyStateProps): ReactNode {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        'py-3xl px-xl',
        className,
      )}
    >
      {icon && (
        <div
          className="mb-lg text-tertiary"
          aria-hidden
        >
          {icon}
        </div>
      )}
      <h3 className="text-title-3 text-primary mb-sm">
        {title}
      </h3>
      {description && (
        <p className="text-callout text-secondary max-w-md mb-lg">
          {description}
        </p>
      )}
      <div className="flex flex-col sm:flex-row items-center gap-sm">
        {action && (
          'href' in action && action.href ? (
            <a
              href={action.href}
              className="inline-flex items-center justify-center h-btn-md px-lg rounded-md font-medium bg-accent text-on-accent hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transition-colors duration-fast"
            >
              {action.label}
            </a>
          ) : 'onClick' in action && action.onClick ? (
            <button
              type="button"
              onClick={action.onClick}
              className="inline-flex items-center justify-center h-btn-md px-lg rounded-md font-medium bg-accent text-on-accent hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transition-colors duration-fast"
            >
              {action.label}
            </button>
          ) : null
        )}
        {secondaryAction && (
          secondaryAction.href ? (
            <a
              href={secondaryAction.href}
              className="inline-flex items-center justify-center h-btn-md px-lg rounded-md font-medium text-accent hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors duration-fast"
            >
              {secondaryAction.label}
            </a>
          ) : (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className="inline-flex items-center justify-center h-btn-md px-lg rounded-md font-medium text-accent hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors duration-fast"
            >
              {secondaryAction.label}
            </button>
          )
        )}
      </div>
    </div>
  );
}
