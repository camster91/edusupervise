// components/shell/Sidebar.tsx — primary navigation rail (HIG spec).
//
// Design system section 2.6 + 3.2:
//   - iPad (md+): adaptive sidebar showing all sections, icons + labels
//   - Phone (<md): hidden, replaced by TabBar
//   - Active item: accent-soft background + accent text + 4px left bar
//   - Hover: surface-2 background
//   - Sections: Today / Roster / Coverage / Reports / Settings (admin gets all 5,
//     teachers get Today / Roster / Coverage / Settings)
//
// Per HIG: tab bars (used on phone) are for PEER sections, not actions.
// Coverage is a peer section, not a button in a tab bar.

import { NavLink } from 'react-router';
import {
  CalendarDays,
  Calendar,
  ListTodo,
  Bell,
  Users,
  Settings,
  GraduationCap,
} from 'lucide-react';
import type { UserRole } from '@edusupervise/db';
import { cn } from '../../lib/cn';

interface SidebarItem {
  to: string;
  label: string;
  end?: boolean;
  icon: typeof CalendarDays;
  adminOnly?: boolean;
  teacherVisible?: boolean;
}

const sidebarItems: SidebarItem[] = [
  { to: '/app/today', label: 'Today', end: true, icon: CalendarDays, teacherVisible: true },
  { to: '/app/duties', label: 'Roster', icon: ListTodo, teacherVisible: true },
  { to: '/app/calendar', label: 'Calendar', icon: Calendar, teacherVisible: true },
  { to: '/app/coverage', label: 'Coverage', icon: Bell, teacherVisible: true },
  { to: '/app/teachers', label: 'Teachers', icon: Users, adminOnly: true },
  { to: '/app/settings', label: 'Settings', icon: Settings, adminOnly: true },
];

export interface SidebarProps {
  role: UserRole;
  className?: string;
}

export function Sidebar({ role, className }: SidebarProps): React.ReactElement {
  const isAdmin = role === 'school_admin';
  const items = sidebarItems.filter(
    (item) => (isAdmin ? true : item.teacherVisible !== false) && (!item.adminOnly || isAdmin),
  );
  return (
    <nav
      aria-label="Primary navigation"
      className={cn(
        'w-sidebar shrink-0 h-full',
        'bg-surface border-r border-border',
        'flex-col',
        'hidden md:flex',
        className,
      )}
    >
      <div className="px-xl py-xl border-b border-divider">
        <BrandMark />
      </div>
      <ul className="flex-1 p-md space-y-xs" role="list">
        {items.map((item) => (
          <li key={item.to}>
            <SidebarLink to={item.to} label={item.label} end={item.end} icon={item.icon} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SidebarLink({
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
          'relative flex items-center gap-md h-btn-md px-md rounded-md',
          'text-body font-medium',
          'transition-colors duration-fast',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
          isActive
            ? 'bg-accent-soft text-accent'
            : 'text-primary hover:bg-surface-2',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              aria-hidden
              className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-accent rounded-r-full"
            />
          )}
          <Icon size={20} aria-hidden className="shrink-0" />
          <span>{label}</span>
        </>
      )}
    </NavLink>
  );
}

function BrandMark(): React.ReactElement {
  return (
    <div className="flex items-center gap-sm">
      <div
        aria-hidden
        className="w-8 h-8 rounded-md flex items-center justify-center text-on-accent font-bold bg-accent"
      >
        <GraduationCap size={18} aria-hidden />
      </div>
      <div>
        <div className="font-semibold text-primary text-callout leading-tight">
          EduSupervise
        </div>
        <div className="text-footnote text-secondary leading-tight">School</div>
      </div>
    </div>
  );
}
