// components/ui/Sheet.tsx — modal sheet with detents (HIG spec).
//
// Design system section 2.7:
//   - Slides up from bottom, rounded top corners (20px)
//   - Background: surface, elevation-3
//   - Detents: [medium, large] — user can drag to half-height or full
//   - Backdrop: 40% black, 200ms fade
//   - Dismiss: drag down, tap backdrop, or close button
//
// Used for: confirm swap, add single duty, accept coverage, alert
// dismissal. NOT for bulk duty assignment or full-page flows.

import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from './Button';

export type SheetDetent = 'medium' | 'large';

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  detent?: SheetDetent;
  /** If true, sheet can't be dismissed by drag (only the X button or backdrop). */
  locked?: boolean;
  children: ReactNode;
  /** Optional footer with action buttons. */
  footer?: ReactNode;
  className?: string;
}

const detentHeight: Record<SheetDetent, string> = {
  medium: 'h-[50vh] max-h-[420px]',
  large: 'h-[90vh] max-h-[800px]',
};

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  detent = 'medium',
  locked = false,
  children,
  footer,
  className,
}: SheetProps): React.ReactElement | null {
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // ESC dismisses (unless locked)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !locked) onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, locked, onOpenChange]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sheet-title"
      aria-describedby={description ? 'sheet-description' : undefined}
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close sheet"
        onClick={() => !locked && onOpenChange(false)}
        className="absolute inset-0 bg-[rgba(10,14,26,0.4)] animate-[fadeIn_200ms_ease-out]"
      />
      {/* Sheet */}
      <div
        ref={sheetRef}
        className={cn(
          'relative w-full max-w-md',
          'bg-surface rounded-t-xl',
          'shadow-elev-3',
          'flex flex-col',
          'animate-[slideUp_250ms_var(--ease-out)]',
          detentHeight[detent],
          className,
        )}
      >
        {/* Drag handle (decorative; full drag-to-dismiss is a follow-up) */}
        <div className="flex justify-center pt-sm" aria-hidden>
          <span className="block w-9 h-1 rounded-full bg-divider" />
        </div>
        <div className="flex items-start justify-between px-xl pt-md pb-sm">
          <div>
            <h2
              id="sheet-title"
              className="text-title-3 text-primary font-semibold"
            >
              {title}
            </h2>
            {description && (
              <p
                id="sheet-description"
                className="text-callout text-secondary mt-xs"
              >
                {description}
              </p>
            )}
          </div>
          <Button
            variant="tertiary"
            size="icon-sm"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
          >
            <X size={18} aria-hidden />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-xl pb-md">{children}</div>
        {footer && (
          <div className="px-xl py-md border-t border-divider flex items-center justify-end gap-sm">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
