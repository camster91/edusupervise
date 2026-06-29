// components/ui/WeekStrip.tsx — horizon strip for cycle visualization (HIG spec).
//
// Design system section 2.4:
//   - Horizontal scroll on phone, full visible on iPad+
//   - Each day: 56pt wide on phone, 80pt on iPad+
//   - Today: filled accent-soft background, accent text
//   - "W2 of 6" badge: pill, surface-2 background
//   - Liquid Glass morph on week-to-week transition
//   - Tap a day → fires onSelect with the day index

import { cn } from '../../lib/cn';

export interface WeekStripDay {
  /** Day index, 0-based. */
  index: number;
  /** Short weekday label, e.g. "Mon". */
  weekday: string;
  /** Day-of-month number, e.g. "9". */
  day: number;
  /** True if this day is "today". */
  isToday?: boolean;
  /** True if this day has duties. Affects the dot indicator. */
  hasDuties?: boolean;
  /** Whether this day is part of the current cycle. */
  inCycle?: boolean;
}

export interface WeekStripProps {
  /** Day labels for the strip. Length = cycle length. */
  days: WeekStripDay[];
  /** Current cycle label, e.g. "W2 of 6". */
  cycleLabel?: string;
  /** Fired when a day is tapped. */
  onSelect?: (index: number) => void;
  className?: string;
}

export function WeekStrip({
  days,
  cycleLabel,
  onSelect,
  className,
}: WeekStripProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex items-center gap-md',
        'bg-surface rounded-lg border border-divider',
        'px-md py-sm',
        className,
      )}
    >
      <div
        className="flex-1 overflow-x-auto"
        role="tablist"
        aria-label="Week selector"
      >
        <ul role="list" className="flex gap-xs">
          {days.map((d) => (
            <li key={d.index}>
              <DayChip day={d} onClick={() => onSelect?.(d.index)} />
            </li>
          ))}
        </ul>
      </div>
      {cycleLabel && (
        <span
          className={cn(
            'shrink-0 inline-flex items-center px-sm py-xs rounded-full',
            'bg-surface-2 text-secondary',
            'text-caption-2 font-semibold uppercase tracking-wide',
          )}
        >
          {cycleLabel}
        </span>
      )}
    </div>
  );
}

function DayChip({
  day,
  onClick,
}: {
  day: WeekStripDay;
  onClick?: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={day.isToday}
      onClick={onClick}
      className={cn(
        'flex flex-col items-center justify-center gap-xs',
        'w-14 h-16 md:w-20 md:h-20',
        'rounded-md',
        'transition-all duration-base ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
        day.isToday
          ? 'bg-accent-soft text-accent'
          : 'text-secondary hover:bg-surface-2',
        !day.inCycle && 'opacity-50',
      )}
    >
      <span className="text-caption-2 font-medium uppercase tracking-wider">
        {day.weekday}
      </span>
      <span className="text-body-em font-semibold tabular">
        {day.day}
      </span>
      {day.hasDuties && (
        <span
          aria-hidden
          className={cn(
            'w-1 h-1 rounded-full',
            day.isToday ? 'bg-accent' : 'bg-secondary',
          )}
        />
      )}
    </button>
  );
}
