// components/shell/Topbar.tsx — top bar of the authenticated layout (HIG spec).
//
// Design system section 2.6 + 3.2:
//   - Slim (56pt height) with 0.5px bottom border
//   - Background: surface, glass effect on iOS 26 (backdrop-filter)
//   - School name (left), notification bell + user badge + logout (right)
//   - On mobile, the hamburger trigger for the drawer (kept as MobileNav
//     for now; will be replaced by TabBar in a follow-up)

import { Form, Link } from 'react-router';
import { LogOut, Menu } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from '../ui/Button';
import { MobileNav } from './MobileNav';
import { NotificationBell } from './NotificationBell';
import type { UserRole } from '@edusupervise/db';

export interface TopbarProps {
  school: { id: string; name: string; plan: string; accentColor: string | null };
  user: { name: string; role: UserRole; email: string };
  unreadCount: number;
  csrfToken: string;
}

export function Topbar({ school, user, unreadCount, csrfToken }: TopbarProps): React.ReactElement {
  return (
    <header
      className={cn(
        'h-topbar shrink-0',
        'bg-surface border-b border-divider',
        'px-lg md:px-xl',
        'flex items-center justify-between gap-md',
        'sticky top-0 z-30',
      )}
    >
      <div className="flex items-center gap-md min-w-0 flex-1">
        <MobileNav role={user.role} school={school} />
        <Link
          to="/app/today"
          className="text-callout md:text-body-em font-semibold text-primary truncate hover:opacity-80"
        >
          {school.name}
        </Link>
        <span
          className={cn(
            'hidden sm:inline-flex items-center px-sm py-xs rounded-full',
            'text-caption-2 font-semibold uppercase tracking-wide',
            planBadgeClass(school.plan),
          )}
          aria-label={`Plan: ${school.plan}`}
        >
          {school.plan}
        </span>
      </div>
      <div className="flex items-center gap-sm md:gap-md flex-shrink-0">
        <NotificationBell unreadCount={unreadCount} />
        <UserBadge user={user} />
        <LogoutForm csrfToken={csrfToken} />
      </div>
    </header>
  );
}

function planBadgeClass(plan: string): string {
  switch (plan) {
    case 'pro':
      return 'bg-accent-soft text-accent';
    case 'school':
      return 'bg-info-soft text-info';
    case 'free':
      return 'bg-surface-2 text-secondary';
    case 'trial':
    default:
      return 'bg-warning-soft text-warning';
  }
}

function UserBadge({ user }: { user: TopbarProps['user'] }): React.ReactElement {
  const initials = user.name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <div className="hidden md:flex items-center gap-sm">
      <div
        aria-hidden
        className="w-8 h-8 rounded-full bg-accent-soft grid place-items-center text-caption-2 font-semibold text-accent"
      >
        {initials || '?'}
      </div>
      <div className="hidden lg:flex flex-col min-w-0">
        <span className="text-footnote font-medium text-primary truncate max-w-[160px]">
          {user.name}
        </span>
        <span className="text-caption-2 text-tertiary truncate max-w-[160px]">{user.email}</span>
      </div>
    </div>
  );
}

function LogoutForm({ csrfToken }: { csrfToken: string }): React.ReactElement {
  return (
    <Form method="post" action="/logout" className="flex items-center">
      <input type="hidden" name="csrf" value={csrfToken} />
      <Button
        type="submit"
        variant="tertiary"
        size="icon-sm"
        aria-label="Sign out"
        title="Sign out"
      >
        <LogOut size={18} aria-hidden />
      </Button>
    </Form>
  );
}
