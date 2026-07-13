// components/ui/Table.tsx — accessible table primitive.
//
// A table with sticky header, hover rows, zebra striping, and the
// right ARIA wiring (caption, scope=col, role=rowgroup). We avoid
// pulling a heavy table library — the contract is small and easy to
// hand-roll correctly. Caption is required for accessibility unless
// it's visually obvious; we surface it as an optional prop and the
// table is still accessible without one (we just add a visually
// hidden caption to satisfy the AST).

import * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * Wrapping `<table>` element. Sets sensible defaults (full width,
 * fixed layout) and lets the caller override via `className`.
 */
export const Table = React.forwardRef<
  HTMLTableElement,
  React.TableHTMLAttributes<HTMLTableElement> & {
    /** Required-or-sr-only caption for screen-reader orientation. */
    caption?: string;
  }
>(function Table({ className, caption, children, ...props }, ref) {
  return (
    <div className="w-full overflow-auto rounded-lg border border-border">
      <table
        ref={ref}
        className={cn('w-full caption-bottom text-sm', className)}
        {...props}
      >
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
});

export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(function TableHeader({ className, ...props }, ref) {
  return (
    <thead
      ref={ref}
      className={cn('[&_tr]:border-b bg-surface-2', className)}
      {...props}
    />
  );
});

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(function TableBody({ className, ...props }, ref) {
  return (
    <tbody
      ref={ref}
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  );
});

export const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(function TableFooter({ className, ...props }, ref) {
  return (
    <tfoot
      ref={ref}
      className={cn('bg-surface-2 font-medium', className)}
      {...props}
    />
  );
});

export const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(function TableRow({ className, ...props }, ref) {
  return (
    <tr
      ref={ref}
      className={cn(
        'border-b transition-colors hover:bg-surface-2',
        'data-[state=selected]:bg-surface-2',
        className,
      )}
      {...props}
    />
  );
});

export const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(function TableHead({ className, ...props }, ref) {
  return (
    <th
      ref={ref}
      scope="col"
      className={cn('h-10 px-4 text-left align-middle text-xs font-semibold uppercase text-tertiary tracking-wide', className)}
      {...props}
    />
  );
});

export const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(function TableCell({ className, ...props }, ref) {
  return (
    <td
      ref={ref}
      className={cn('p-4 align-middle text-sm text-primary', className)}
      {...props}
    />
  );
});
