// components/shell/MobileNav.tsx — hamburger menu / slide-in drawer for
// mobile widths.
//
// Spec section 9: "Radix Dialog with hamburger trigger."
//
// We use a slide-from-left sheet variant of the same `DialogContent`
// primitive used elsewhere — same focus trap, same ESC handling.
// On `md:` the trigger button is hidden (the sidebar is visible there
// instead). The drawer closes after any nav interaction so the next
// page lands on a clean viewport.

import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { Menu, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '../ui/Dialog';
import { Button } from '../ui/Button';
import { cn } from '../../lib/cn';
import type { UserRole } from '@edusupervise/db';

export interface MobileNavProps {
  role: UserRole;
  school: { name: string; accentColor: string | null };
}

interface SheetLink {
  to: string;
  label: string;
  end?: boolean;
}

const allLinks: Array<SheetLink & { adminOnly?: boolean }> = [
  { to: '/app', label: 'Dashboard', end: true },
  { to: '/app/duties', label: 'Duties' },
  { to: '/app/calendar', label: 'Calendar' },
  { to: '/app/assignments', label: 'Assignments' },
  { to: '/app/reminders', label: 'Reminders' },
  { to: '/app/notifications', label: 'Notifications' },
  { to: '/app/teachers', label: 'Teachers', adminOnly: true },
  { to: '/app/reports', label: 'Reports', adminOnly: true },
  { to: '/app/settings', label: 'Settings', adminOnly: true },
  { to: '/app/profile', label: 'Profile' },
];

export function MobileNav({ role, school }: MobileNavProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const visibleLinks = allLinks.filter((link) => !link.adminOnly || role === 'school_admin');

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="tertiary"
          size="icon"
          aria-label="Open navigation menu"
          className={cn('md:hidden')}
        >
          <Menu className="h-5 w-5" aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent
        // sheet-from-left variant
        className={cn(
          'fixed left-0 top-0 translate-x-0 translate-y-0 h-screen w-72 max-w-[85vw] rounded-r-2xl rounded-l-none',
          'flex flex-col gap-0 text-left p-0',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left',
        )}
        closeLabel="Close navigation menu"
      >
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <div>
            <DialogTitle className="text-base font-semibold">
              {school.name}
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-500">
              EduSupervise
            </DialogDescription>
          </div>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close navigation menu"
            className={cn(
              'rounded-md p-1 text-slate-500 hover:text-slate-900',
              'hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            )}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <nav aria-label="Mobile navigation" className="flex-1 overflow-y-auto p-2">
          <ul role="list" className="space-y-1">
            {visibleLinks.map((link) => {
              const active = link.end
                ? location.pathname === link.to
                : location.pathname.startsWith(link.to);
              return (
                <li key={link.to}>
                  <SheetLink
                    to={link.to}
                    active={active}
                    onClick={() => setOpen(false)}
                  >
                    {link.label}
                  </SheetLink>
                </li>
              );
            })}
          </ul>
        </nav>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A single nav entry inside the sheet. Wraps `react-router`'s
 * `<Link>` (still a `<a>` underneath, but with client-side
 * navigation) plus an `aria-current` flag for the active item.
 */
function SheetLink({
  to,
  active,
  onClick,
  children,
}: {
  to: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}): React.ReactElement {
  return (
    <Link
      to={to}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'block px-4 py-2.5 rounded-lg text-sm font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1',
        active
          ? 'bg-blue-50 text-blue-700'
          : 'text-slate-700 hover:bg-slate-100',
      )}
    >
      {children}
    </Link>
  );
}
