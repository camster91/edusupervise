// apps/web/app/components/Skeleton.tsx
//
// Skeleton placeholder for loading states. Audit slice-4 R-F2 finding:
// /app/today and friends used to flash an empty-state container for
// 200-500ms during the loader-data fetch. Now we show a pulse-grey
// rectangle matching the final content's footprint, then swap to
// the real data when the loader resolves.
//
// Variants:
//   <Skeleton />                  — block (full width, default height 1rem)
//   <Skeleton width="w-1/2" />    — half-width block
//   <Skeleton circle />            — circle (avatar etc.)
//   <Skeleton rows={3} />          — stack of 3 block rows
//   <Skeleton variant="card" />    — card-shaped block with rounded corners

import type { ReactNode } from 'react';

export interface SkeletonProps {
  /** Tailwind width class, e.g. "w-full", "w-1/2", "w-32". Default: w-full. */
  width?: string;
  /** Tailwind height class, e.g. "h-4", "h-12". Default: h-4. */
  height?: string;
  /** Render as a circle (avatar/avatar-shaped placeholder). */
  circle?: boolean;
  /** Render N stacked rows of skeleton blocks. */
  rows?: number;
  /** Card-shaped rounded rectangle (for full-card loading states). */
  variant?: 'block' | 'card';
  /** Override the rounded class. Default: rounded-md (block) / rounded-2xl (card). */
  rounded?: string;
  className?: string;
}

export function Skeleton({
  width = 'w-full',
  height = 'h-4',
  circle = false,
  rows,
  variant = 'block',
  rounded,
  className = '',
}: SkeletonProps): ReactNode {
  if (rows !== undefined && rows > 0) {
    return (
      <div className={`space-y-sm ${className}`}>
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton
            key={i}
            width={i === rows - 1 ? 'w-2/3' : 'w-full'}
            height={height}
            circle={circle}
            variant={variant}
            rounded={rounded}
          />
        ))}
      </div>
    );
  }

  const sizeClass = circle ? 'rounded-full' : rounded ?? (variant === 'card' ? 'rounded-2xl' : 'rounded-md');
  return (
    <div
      role="status"
      aria-label="Loading"
      className={`animate-pulse bg-surface-2 ${sizeClass} ${width} ${height} ${className}`}
    />
  );
}

/**
 * Section-level wrapper: shows a stack of skeleton rows inside a card.
 * Use as a HydrateFallback for /app/* routes.
 */
export function SkeletonCard({
  rows = 3,
  className = '',
}: {
  rows?: number;
  className?: string;
}): ReactNode {
  return (
    <section
      className={`bg-surface border border-border rounded-xl p-xl ${className}`}
    >
      <Skeleton variant="card" width="w-1/3" height="h-6" className="mb-md" />
      <Skeleton rows={rows} height="h-4" />
    </section>
  );
}