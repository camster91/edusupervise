// components/shell/TabBar.tsx — iOS 26 adaptive tab bar (HIG spec).
//
// Design system section 2.5 + 3.2:
//   - iPhone only (hidden on md+ where Sidebar takes over)
//   - 4 peer sections for teachers: Today / Roster / Coverage / Settings
//   - 49pt height + safe-area-inset-bottom
//   - Glass effect on iOS 26+ (backdrop-filter: blur)
//   - Active: accent color + dot indicator above icon
//   - Inactive: tertiary text color
//   - HIG: tab bars are for PEER sections, not actions. Coverage lives as
//     a peer tab, not as a FAB.

import { NavLink } from 'react-router';
import {
  CalendarDays,
  ListTodo,
  Bell,
  Settings,
} from 'lucide-react';
import { cn } from '../../lib/cn';

interface TabItem {
  to: string;
  label: string;
  end?: boolean;
  icon: typeof CalendarDays;
}

const tabItems: TabItem[] = [
  { to: '/app/today', label: 'Today', end: true, icon: CalendarDays },
  { to: '/app/duties', label: 'Roster', icon: ListTodo },
  { to: '/app/coverage', label: 'Coverage', icon: Bell },
  { to: '/app/settings', label: 'Settings', icon: Settings },
];

export function TabBar(): React.ReactElement {
  return (
    <nav
      aria-label="Primary navigation"
      className={cn(
        'h-tabbar shrink-0',
        'bg-surface border-t border-divider glass',
        'md:hidden',
        'sticky bottom-0 z-30',
        // Account for iOS safe-area inset
        'pb-[env(safe-area-inset-bottom)]',
      )}
    >
      <ul role="list" className="flex h-full">
        {tabItems.map((item) => (
          <li key={item.to} className="flex-1">
            <TabBarLink to={item.to} label={item.label} end={item.end} icon={item.icon} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

function TabBarLink({
  to,
  label,
  end,
  icon: Icon,
}: {
  to: string;
  label: string;
  end?: boolean;
  icon: typeof CalendarDays;
}): React.ReactElement {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'flex flex-col items-center justify-center gap-xs h-full',
          'text-caption-2 font-medium',
          'transition-colors duration-fast',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
          isActive ? 'text-accent' : 'text-tertiary',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span className="relative">
            {isActive && (
              <span
                aria-hidden
                className="absolute -top-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-accent"
              />
            )}
            <Icon size={24} aria-hidden />
          </span>
          <span>{label}</span>
        </>
      )}
    </NavLink>
  );
}
