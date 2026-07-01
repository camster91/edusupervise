// components/ui/AddDutyEmptyState.tsx — dashed-border "+ Add Duty"
// placeholder for the Today / Calendar views when there are no
// duties to display. Inspired by the reference Replit prototype's
// dashed-card CTA on the Today grid.
//
// Three states:
//   - Admin with no duties:    big "+ Add a duty" CTA → /app/calendar/new
//   - Admin with duties:       show as the next slot in a grid
//   - Teacher with no duties:  "You're free today" + browse coverage
//                              (no CTA — teachers don't author duties)

import { Link } from 'react-router';
import { Plus, Sparkles } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface AddDutyEmptyStateProps {
  /** User's role. Determines whether we show the author CTA. */
  role: 'school_admin' | 'teacher' | 'substitute';
  /** When true, render compact (single row, no body). Used inside grids. */
  compact?: boolean;
  className?: string;
}

export function AddDutyEmptyState({
  role,
  compact = false,
  className,
}: AddDutyEmptyStateProps): React.ReactElement {
  const isAdmin = role === 'school_admin';

  if (compact) {
    // Compact form — used as a "slot" inside a grid of duty cards.
    if (isAdmin) {
      return (
        <Link
          to="/app/calendar/new"
          className={cn(
            'flex items-center justify-center gap-sm',
            'rounded-lg border-2 border-dashed border-border-strong',
            'bg-surface-2 text-secondary',
            'px-lg py-md min-h-[64px]',
            'hover:bg-accent-soft hover:border-accent hover:text-accent',
            'transition-colors duration-fast',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
            className,
          )}
          aria-label="Add a duty"
        >
          <Plus size={18} aria-hidden />
          <span className="text-callout font-semibold">Add Duty</span>
        </Link>
      );
    }
    // Teacher — no add CTA, just a calm "nothing here" row.
    return (
      <div
        className={cn(
          'flex items-center justify-center',
          'rounded-lg border border-divider bg-surface',
          'px-lg py-md min-h-[64px]',
          'text-footnote text-tertiary',
          className,
        )}
      >
        Nothing scheduled
      </div>
    );
  }

  // Full-card empty state — used when the section has zero duties.
  if (isAdmin) {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center text-center',
          'rounded-xl border-2 border-dashed border-border-strong',
          'bg-surface-2 text-secondary',
          'px-xl py-3xl',
          className,
        )}
      >
        <Plus size={36} aria-hidden className="mb-md text-tertiary" />
        <h3 className="text-title-3 text-primary font-semibold mb-sm">
          No duties scheduled
        </h3>
        <p className="text-callout text-secondary max-w-md mb-lg">
          Add the supervision duties your school runs each day — cafeteria,
          recess, dismissal — and assign them to teachers. They'll see them
          on their Today view.
        </p>
        <Link
          to="/app/calendar/new"
          className={cn(
            'inline-flex items-center gap-sm h-btn-md px-lg rounded-md font-semibold',
            'bg-accent text-on-accent hover:opacity-90',
            'transition-opacity duration-fast',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
          )}
        >
          <Plus size={18} aria-hidden />
          Add a duty
        </Link>
      </div>
    );
  }

  // Teacher view — different tone, no CTA.
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        'rounded-xl border border-divider bg-surface',
        'px-xl py-3xl',
        className,
      )}
    >
      <Sparkles size={36} aria-hidden className="mb-md text-success" />
      <h3 className="text-title-3 text-primary font-semibold mb-sm">
        You're free today
      </h3>
      <p className="text-callout text-secondary max-w-md mb-lg">
        No duties assigned. If this is unexpected, check with your school's
        duty coordinator or browse open swaps if you'd like to help out.
      </p>
      <Link
        to="/app/coverage"
        className={cn(
          'inline-flex items-center gap-sm h-btn-md px-lg rounded-md font-medium',
          'text-accent hover:bg-accent-soft',
          'transition-colors duration-fast',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
        )}
      >
        Browse open swaps
      </Link>
    </div>
  );
}