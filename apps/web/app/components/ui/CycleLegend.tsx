// components/ui/CycleLegend.tsx — colored-dot legend for the 5-day
// rotation. Sits below the WeekStrip on Today so the rotation is
// visually obvious. Inspired by the reference Replit prototype.
//
// Usage:
//   <CycleLegend todayCycleDay={2} />
//
// If `todayCycleDay` is provided, that day's dot gets a ring so
// teachers can find "today" in the rotation at a glance.

import { cn } from '../../lib/cn';

export interface CycleLegendProps {
  /** Today's cycle day, 1-5. Highlights that day with a ring. */
  todayCycleDay?: number | null;
  /** Number of days in the cycle. Defaults to 5. */
  cycleLength?: 5 | 6;
  className?: string;
}

const CYCLE_CLASSES: Record<number, { dot: string; soft: string; text: string; label: string }> = {
  1: { dot: 'bg-cycle-1',       soft: 'bg-cycle-1-soft', text: 'text-cycle-1', label: 'Day 1' },
  2: { dot: 'bg-cycle-2',       soft: 'bg-cycle-2-soft', text: 'text-cycle-2', label: 'Day 2' },
  3: { dot: 'bg-cycle-3',       soft: 'bg-cycle-3-soft', text: 'text-cycle-3', label: 'Day 3' },
  4: { dot: 'bg-cycle-4',       soft: 'bg-cycle-4-soft', text: 'text-cycle-4', label: 'Day 4' },
  5: { dot: 'bg-cycle-5',       soft: 'bg-cycle-5-soft', text: 'text-cycle-5', label: 'Day 5' },
  6: { dot: 'bg-secondary',     soft: 'bg-surface-2',     text: 'text-secondary', label: 'Day 6' },
};

export function CycleLegend({
  todayCycleDay,
  cycleLength = 5,
  className,
}: CycleLegendProps): React.ReactElement {
  const days = Array.from({ length: cycleLength }, (_, i) => i + 1);

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-md gap-y-xs',
        'text-footnote text-secondary',
        className,
      )}
      role="group"
      aria-label="Cycle day legend"
    >
      <span className="text-caption-2 font-semibold uppercase tracking-wider text-tertiary">
        Rotation
      </span>
      {days.map((d) => {
        const c = CYCLE_CLASSES[d] ?? CYCLE_CLASSES[1]!;
        const isToday = todayCycleDay === d;
        return (
          <span
            key={d}
            className={cn(
              'inline-flex items-center gap-xs',
              isToday && c.text,
            )}
            aria-current={isToday ? 'true' : undefined}
          >
            <span
              aria-hidden
              className={cn(
                'w-2 h-2 rounded-full',
                c.dot,
                isToday && 'ring-2 ring-offset-2 ring-offset-bg',
                isToday && 'ring-current',
              )}
            />
            <span className={cn('font-medium', isToday && 'font-semibold')}>
              {c.label}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * Map a cycle day number (1-N) to its associated Tailwind color
 * classes. Use this when you want a day chip elsewhere (e.g. on a
 * duty card or coverage request) to match the legend.
 */
export function cycleDayClasses(day: number | null | undefined): string {
  if (!day) return 'bg-surface-2 text-secondary';
  const c = CYCLE_CLASSES[day] ?? CYCLE_CLASSES[1]!;
  return `${c.dot.replace('bg-', 'bg-')} ${c.text}`;
}

/**
 * Soft variant — light pastel background + saturated text. Best for
 * headers, chips, and anywhere the saturated background would make the
 * text hard to read. Used by the print view's column headers.
 */
export function cycleDaySoftClasses(day: number | null | undefined): string {
  if (!day) return 'bg-surface-2 text-secondary';
  const c = CYCLE_CLASSES[day] ?? CYCLE_CLASSES[1]!;
  return `${c.soft} ${c.text}`;
}