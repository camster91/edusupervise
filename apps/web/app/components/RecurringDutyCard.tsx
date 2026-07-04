// apps/web/app/components/RecurringDutyCard.tsx
//
// Phase 3 §3.2 — small display-only card for a single recurring duty.
//
// Rendered on /app/today alongside the cycle-day duty cards so teachers
// can see "Early Entry 8:45-9:00" next to their cycle-day duties.
// Read-only: edit/deactivate live on /app/recurring (admin-only).
//
// Two display modes:
//   - "today-only" (compact): if a days_of_week bitmask doesn't match
//     today, we don't render. The parent passes today's dayBit directly.
//   - "all-week" (full): show every day it's set for as chips.

import * as React from 'react';
import { CalendarClock, Clock } from 'lucide-react';
import { EquipmentChips } from './ui/EquipmentChips';
import { cn } from '../lib/cn';

const DOW_LABELS: Array<{ key: string; bit: number; label: string }> = [
  { key: 'Mon', bit: 1, label: 'Mon' },
  { key: 'Tue', bit: 2, label: 'Tue' },
  { key: 'Wed', bit: 4, label: 'Wed' },
  { key: 'Thu', bit: 8, label: 'Thu' },
  { key: 'Fri', bit: 16, label: 'Fri' },
  { key: 'Sat', bit: 32, label: 'Sat' },
  { key: 'Sun', bit: 64, label: 'Sun' },
];

const DAY_OF_WEEK_BIT_FOR_INDEX: Record<number, number> = {
  // 0 = Sun, 1 = Mon, 2 = Tue, 3 = Wed, 4 = Thu, 5 = Fri, 6 = Sat
  0: 64,
  1: 1,
  2: 2,
  3: 4,
  4: 8,
  5: 16,
  6: 32,
};

export interface RecurringDutyCardProps {
  duty: {
    id: string;
    name: string;
    location: string | null;
    startTime: string;
    endTime: string;
    daysOfWeek: number;
    assignedUserId: string | null;
    assignedUserName?: string | null;
    requiresVest: boolean;
    requiresRadio: boolean;
  };
  /** Current day index, 0=Sun..6=Sat. If provided and the duty's bitmask
   *  doesn't include this day, we still render (just dim the day chip). */
  currentDayIndex?: number | null;
  /** Compact view (slim card on /app/today). Default false = full. */
  compact?: boolean;
  className?: string;
}

export function RecurringDutyCard({
  duty,
  currentDayIndex = null,
  compact = false,
  className,
}: RecurringDutyCardProps): React.ReactElement {
  const enabledDays = DOW_LABELS.filter((d) => (duty.daysOfWeek & d.bit) !== 0);
  const activeTodayBit = currentDayIndex != null
    ? DAY_OF_WEEK_BIT_FOR_INDEX[currentDayIndex]
    : null;
  const firesToday = activeTodayBit != null && (duty.daysOfWeek & activeTodayBit) !== 0;

  return (
    <li
      className={cn(
        'rounded-lg border border-border bg-surface p-md hover:bg-surface-2 transition-colors duration-fast',
        !firesToday && 'opacity-80',
        compact ? 'space-y-xs' : 'space-y-sm',
        className,
      )}
      data-fires-today={firesToday ? 'true' : 'false'}
      data-recurring-duty-id={duty.id}
    >
      <div className="flex items-start gap-md">
        <div className="flex flex-col items-start w-20 shrink-0">
          <div className="flex items-center gap-1 text-footnote text-accent">
            <CalendarClock size={12} aria-hidden />
            <span className="uppercase tracking-wide font-semibold">Recur</span>
          </div>
          <div className="text-title-3 text-primary font-semibold tabular mt-xs">
            {formatTime12h(duty.startTime)}
          </div>
          {!compact && (
            <div className="text-footnote text-secondary tabular">
              {formatTime12h(duty.startTime)} – {formatTime12h(duty.endTime)}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-body-em text-primary font-semibold">{duty.name}</div>
          {duty.location && (
            <div className="text-footnote text-secondary mt-xs">
              <span className="inline-flex items-center gap-1">
                <Clock size={12} aria-hidden />
                {duty.location}
              </span>
            </div>
          )}
          {duty.assignedUserName && (
            <div className="text-footnote text-secondary mt-xs">
              <span className="text-tertiary">Assigned: </span>
              <span className="text-primary font-medium">{duty.assignedUserName}</span>
            </div>
          )}
          <ul className="mt-sm flex flex-wrap gap-xs" role="list">
            {enabledDays.map((d) => (
              <li
                key={d.key}
                className={cn(
                  'inline-flex items-center px-sm py-0.5 rounded-full text-caption-2 font-medium tabular',
                  (activeTodayBit != null && d.bit === activeTodayBit)
                    ? 'bg-accent-soft text-accent'
                    : 'bg-surface-3 text-secondary',
                )}
              >
                {d.label}
              </li>
            ))}
          </ul>
          <div className="mt-sm">
            <EquipmentChips
              requiresVest={duty.requiresVest}
              requiresRadio={duty.requiresRadio}
              compact
            />
          </div>
        </div>
      </div>
    </li>
  );
}

function formatTime12h(hhmm: string | null | undefined): string {
  if (!hhmm) return '—';
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = (h ?? 0) >= 12 ? 'PM' : 'AM';
  const h12 = (h ?? 0) % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}
