// components/ui/HeroCard.tsx — iStudiez-style current/next duty card.
//
// Design system section 2.3 (the load-bearing component):
//   - "NOW" + current duty: time (display 34px), name, location
//   - "NEXT" + upcoming duty: time (title-2 28px), name, location
//   - Green dot when a duty is currently active
//   - Optional conflict warning banner above the card
//   - Optional action buttons row (Swap, Mark complete, etc.)
//   - States: current-active, conflict, upcoming-only, empty
//   - Background: surface, border, 20px radius, 32px padding

import { Circle, MapPin, Clock, AlertTriangle } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface DutyRef {
  /** Stable id. */
  id: string;
  /** Display name, e.g. "Cafeteria duty", "Bus duty". */
  name: string;
  /** Location or extra context, e.g. "Bus 7", "Mrs. Smith room". */
  location?: string;
  /** Time string, e.g. "11:30 AM". Format any way you want; we display as-is. */
  time: string;
  /** Whether the duty is currently active (the "NOW" dot is green if so). */
  active?: boolean;
}

export interface HeroCardProps {
  current?: DutyRef;
  next?: DutyRef;
  /** Render the conflict warning above the card. */
  conflict?: {
    message: string;
    resolveLabel?: string;
    onResolve?: () => void;
  };
  /** Actions for the current duty (Swap, Mark complete). */
  actions?: React.ReactNode;
  className?: string;
}

export function HeroCard({
  current,
  next,
  conflict,
  actions,
  className,
}: HeroCardProps): React.ReactElement {
  return (
    <div
      className={cn(
        'bg-surface rounded-xl border border-border shadow-elev-1',
        'p-2xl',
        className,
      )}
    >
      {conflict && (
        <div
          role="alert"
          className={cn(
            'flex items-center gap-sm',
            'mb-lg p-md rounded-md',
            'bg-warning-soft text-warning',
          )}
        >
          <AlertTriangle size={18} aria-hidden className="shrink-0" />
          <p className="flex-1 text-callout">{conflict.message}</p>
          {conflict.onResolve && conflict.resolveLabel && (
            <button
              type="button"
              onClick={conflict.onResolve}
              className={cn(
                'shrink-0 px-sm py-xs rounded-sm',
                'text-callout font-medium underline underline-offset-2',
                'hover:bg-warning hover:text-on-accent',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning',
                'transition-colors duration-fast',
              )}
            >
              {conflict.resolveLabel}
            </button>
          )}
        </div>
      )}

      {current ? (
        <DutyBlock label="Now" duty={current} variant="current" />
      ) : (
        <EmptyState />
      )}

      {next && (
        <>
          <div className="my-lg border-t border-divider" aria-hidden />
          <DutyBlock label="Next" duty={next} variant="next" />
        </>
      )}

      {actions && (
        <div className="mt-xl flex flex-wrap items-center gap-sm">
          {actions}
        </div>
      )}
    </div>
  );
}

function DutyBlock({
  label,
  duty,
  variant,
}: {
  label: string;
  duty: DutyRef;
  variant: 'current' | 'next';
}): React.ReactElement {
  return (
    <div className="flex items-start gap-md">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-sm mb-xs">
          <span className="text-subhead text-secondary uppercase tracking-wider">
            {label}
          </span>
          {variant === 'current' && duty.active && (
            <span
              aria-label="Duty is active"
              className="inline-flex items-center gap-xs text-caption-2 font-semibold text-success"
            >
              <Circle size={8} fill="currentColor" aria-hidden />
              Active
            </span>
          )}
        </div>
        <div className={cn(
          variant === 'current' ? 'text-display' : 'text-title-1',
          'text-primary font-bold',
          'tabular',
          'leading-none',
        )}>
          {duty.time}
        </div>
        <div className={cn(
          variant === 'current' ? 'text-title-3' : 'text-callout',
          'text-primary font-semibold mt-xs',
        )}>
          {duty.name}
        </div>
        {duty.location && (
          <div className="flex items-center gap-xs text-callout text-secondary mt-xs">
            <MapPin size={14} aria-hidden className="shrink-0" />
            <span>{duty.location}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState(): React.ReactElement {
  return (
    <div className="flex items-center gap-md py-md">
      <Clock size={24} aria-hidden className="text-tertiary" />
      <div>
        <div className="text-subhead text-secondary uppercase tracking-wider">Now</div>
        <div className="text-body text-primary mt-xs">
          No duty right now. Take a breath.
        </div>
      </div>
    </div>
  );
}
