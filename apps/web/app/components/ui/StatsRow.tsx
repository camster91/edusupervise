// components/ui/StatsRow.tsx — single-row of stat cards.
//
// Inspired by the reference Replit prototype's bottom row on the
// dashboard (Total Duties / Hours Total / Locations), but extended
// to surface "My Upcoming" so the logged-in teacher sees their own
// week at a glance.
//
// Progressive-disclosure rule: show at most 4 stats on Today. If we
// ever need more (fairness, coverage rate, etc.), they go behind an
// /app/insights link, not into the same row.

import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface StatCardData {
  /** Big number or short string ("12", "3.5h", "8"). */
  value: string | number;
  /** Label below the number. */
  label: string;
  /** Optional supporting caption (e.g. "this week", "across school"). */
  caption?: string;
  /** Lucide icon shown tinted above the number. */
  icon: LucideIcon;
  /** Hex/CSS color string for the icon tint. Defaults to --color-accent. */
  iconClassName?: string;
  /** Optional href — wraps the card in a Link when set. */
  href?: string;
}

export interface StatsRowProps {
  cards: StatCardData[];
  className?: string;
}

export function StatsRow({ cards, className }: StatsRowProps): React.ReactElement {
  return (
    <div
      className={cn(
        'grid gap-md',
        // 1 col on phones, 2 on iPad portrait, 4 on iPad landscape.
        'grid-cols-2 md:grid-cols-2 lg:grid-cols-4',
        className,
      )}
      role="list"
    >
      {cards.map((c, i) => (
        <StatCard key={`${c.label}-${i}`} {...c} />
      ))}
    </div>
  );
}

function StatCard(props: StatCardData): React.ReactElement {
  const Icon = props.icon;
  const content = (
    <div
      className={cn(
        'flex items-center gap-md',
        'bg-surface rounded-xl border border-border shadow-elev-1',
        'px-lg py-lg',
        'transition-colors duration-fast',
        props.href && 'hover:bg-surface-2 cursor-pointer',
      )}
    >
      <div
        aria-hidden
        className={cn(
          'shrink-0 w-10 h-10 rounded-full',
          'grid place-items-center',
          props.iconClassName ?? 'bg-accent-soft text-accent',
        )}
      >
        <Icon size={20} aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-title-1 text-primary font-bold leading-none tabular">
          {props.value}
        </div>
        <div className="text-callout text-secondary mt-xs">{props.label}</div>
        {props.caption && (
          <div className="text-footnote text-tertiary mt-xs">
            {props.caption}
          </div>
        )}
      </div>
    </div>
  );

  if (props.href) {
    return (
      <a href={props.href} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded-xl" role="listitem">
        {content}
      </a>
    );
  }
  return <div role="listitem">{content}</div>;
}