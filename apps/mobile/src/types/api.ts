// apps/mobile/src/types/api.ts
//
// Mobile-side response shapes. These mirror what the web app's loader
// returns. The web source of truth is
// apps/web/app/routes/_app.today._index.tsx#loader; the JSON shim
// at apps/web/app/routes/app.api.today.ts produces a 1:1 shape.
//
// When the web loader shape changes, this file changes in lockstep.
// Drift here = mobile shows wrong data, so keep the field names
// verbatim (we re-use the web's snake_case for Drizzle fields and
// camelCase for the API response keys — see notes below).

/** Roster member for a duty, mirror of duty-assignments.server.ts. */
export interface GroupRosterMember {
  userId: string;
  userName: string;
  coverageRole: 'primary' | 'backup' | 'rotation';
}

/** Single duty, shape returned by the shim's `allDuties` field. */
export interface TodayDuty {
  id: string;
  name: string;
  location: string | null;
  startTime: string | null;
  endTime: string | null;
  cycleDay: number;
  requiresVest: boolean;
  requiresRadio: boolean;
}

/** A row in the shim's `myAssignments` field. */
export interface TodayAssignment {
  dutyId: string;
  startDate: string;
  endDate: string | null;
}

/** Recurring duty shape, used by the (web-only) recurring card. */
export interface RecurringDuty {
  id: string;
  name: string;
  location: string;
  startTime: string;
  endTime: string;
  daysOfWeek: string[];
  assignedUserId: string | null;
  assignedUserName: string | null;
  requiresVest: boolean;
  requiresRadio: boolean;
}

/**
 * Reminder shape, mirrors ReminderRow from reminders.server.ts.
 * Mobile only reads `minutesBefore` and `isEnabled` for the
 * "X minutes before" hint; the rest is for future "configure
 * reminder" UI (Sprint 2).
 */
export interface Reminder {
  id: string;
  schoolId: string;
  assignmentId: string;
  userId: string | null;
  userName: string | null;
  dutyLocation: string;
  dutyStartTime: string;
  minutesBefore: number;
  isEnabled: boolean;
  notifyEmail: boolean;
  notifySms: boolean;
  customMessage: string | null;
  createdAt: string;
}

export interface TodayStats {
  totalDuties: number;
  totalLocations: number;
  myUpcoming: number;
  myMinutesPerWeek: number;
}

export type UserRole =
  | 'teacher'
  | 'school_admin'
  | 'educational_assistant';

/**
 * Top-level shape returned by GET /app/api/today.
 *
 * Field naming: `myAssignments` is plural-camelCase to match the
 * web loader (which returns `myAssignments: Assignment[]`). The
 * `groupRoster` keys are dutyIds (strings); the values are arrays
 * of group-roster members. The `reminderMap` is keyed by dutyId
 * with `Reminder[]` values.
 */
export interface TodayResponse {
  role: UserRole;
  userId: string;
  today: string;
  tomorrow: string;
  weekFromNow: string;
  allDuties: TodayDuty[];
  myAssignments: TodayAssignment[];
  cycleDay: number | null;
  isSchoolDay: boolean;
  stats: TodayStats;
  groupRoster: Record<string, GroupRosterMember[]>;
  recurringDuties: RecurringDuty[];
  showOnboardingBanner: boolean;
  reminderMap: Record<string, Reminder[]>;
}

/** Standard error envelope used by all web API routes. */
export interface ApiErrorBody {
  error: string;
  detail?: string;
}
