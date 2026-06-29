// components/shell/NotificationBell.tsx — HIG-style bell with badge (HIG spec).
//
// Design system section 2.5:
//   - 44pt touch target
//   - Subtle hover (surface-2)
//   - Badge: 18pt circle, accent color, top-right
//   - a11y: aria-label includes count, sr-only duplicate for screen readers

import { Link } from 'react-router';
import { Bell } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface NotificationBellProps {
  unreadCount: number;
  to?: string;
  className?: string;
}

export function NotificationBell({
  unreadCount,
  to = '/app/notifications',
  className,
}: NotificationBellProps): React.ReactElement {
  const hasUnread = unreadCount > 0;
  const accessibleLabel = hasUnread
    ? `Notifications, ${unreadCount} unread`
    : 'Notifications';
  return (
    <Link
      to={to}
      aria-label={accessibleLabel}
      className={cn(
        'relative inline-flex items-center justify-center h-tabbar w-tabbar rounded-md',
        'text-secondary hover:text-primary hover:bg-surface-2',
        'transition-colors duration-fast',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
        className,
      )}
      title="Notifications"
    >
      <Bell size={20} aria-hidden />
      {hasUnread && (
        <>
          <span
            aria-hidden
            data-testid="notification-bell-badge"
            className={cn(
              'absolute top-1.5 right-1.5 inline-flex items-center justify-center',
              'min-w-[18px] h-[18px] px-1 rounded-full text-caption-2 font-semibold',
              'bg-error text-on-accent ring-2 ring-surface',
            )}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
          <span className="sr-only">
            {unreadCount} unread notifications
          </span>
        </>
      )}
    </Link>
  );
}
