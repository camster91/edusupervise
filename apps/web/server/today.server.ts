import { and, eq, isNull, or } from 'drizzle-orm';
import {
  cycleCalendar,
  duties,
  dutyAssignments,
  recurringDuties,
  schools,
  users,
} from '@edusupervise/db';
import { addCalendarDays } from '../app/lib/calendar-date';
import type { Session } from './auth.server';
import { withSchoolId } from './db.server';
import { getGroupDutyRoster } from './duty-assignments.server';
import {
  listRemindersForDuties,
  type ReminderRow,
} from './reminders.server';

export interface TodayLoaderOptions {
  /** Test seam for deterministic date-boundary coverage. */
  now?: Date;
}

export interface TodayData {
  role: Session['role'];
  userId: string;
  today: string;
  tomorrow: string;
  weekFromNow: string;
  allDuties: Array<{
    id: string;
    name: string;
    location: string;
    startTime: string;
    endTime: string;
    cycleDay: number;
    requiresVest: boolean;
    requiresRadio: boolean;
  }>;
  myAssignments: Array<{
    dutyId: string;
    startDate: string;
    endDate: string | null;
  }>;
  cycleDay: number | null;
  isSchoolDay: boolean;
  stats: {
    totalDuties: number;
    totalLocations: number;
    myUpcoming: number;
    myMinutesPerWeek: number;
  };
  groupRoster: Record<
    string,
    Array<{
      userId: string;
      userName: string;
      coverageRole: 'primary' | 'backup' | 'rotation';
    }>
  >;
  recurringDuties: Array<{
    id: string;
    name: string;
    location: string | null;
    startTime: string | null;
    endTime: string | null;
    daysOfWeek: string[];
    assignedUserId: string | null;
    assignedUserName: string | null;
    requiresVest: boolean;
    requiresRadio: boolean;
  }>;
  showOnboardingBanner: boolean;
  reminderMap: Record<string, ReminderRow[]>;
}

/** Format an instant as YYYY-MM-DD in an IANA timezone. */
function formatDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function getTodayDateKeys(
  now: Date,
  timeZone: string,
): { today: string; tomorrow: string; weekFromNow: string } {
  const today = formatDateInTimeZone(now, timeZone);
  return {
    today,
    tomorrow: addCalendarDays(today, 1),
    weekFromNow: addCalendarDays(today, 7),
  };
}

export async function loadTodayData(
  session: Session,
  options: TodayLoaderOptions = {},
): Promise<TodayData> {
  const data = await withSchoolId(session.schoolId, async (tx) => {
    const [school] = await tx
      .select({
        timezone: schools.timezone,
        demoExpiresAt: schools.demoExpiresAt,
      })
      .from(schools)
      .where(eq(schools.id, session.schoolId))
      .limit(1);
    const timeZone = school?.timezone ?? 'America/Toronto';
    const isSoloSchool = !school?.demoExpiresAt;
    const { today, tomorrow, weekFromNow } = getTodayDateKeys(
      options.now ?? new Date(),
      timeZone,
    );

    const [allDuties, myAssignments, cycleRows] = await Promise.all([
      tx
        .select({
          id: duties.id,
          name: duties.location,
          location: duties.location,
          startTime: duties.startTime,
          endTime: duties.endTime,
          cycleDay: duties.cycleDay,
          requiresVest: duties.requiresVest,
          requiresRadio: duties.requiresRadio,
        })
        .from(duties)
        .where(eq(duties.isActive, true))
        .limit(200),
      tx
        .select({
          dutyId: dutyAssignments.dutyId,
          startDate: dutyAssignments.startDate,
          endDate: dutyAssignments.endDate,
        })
        .from(dutyAssignments)
        .where(
          and(
            eq(dutyAssignments.userId, session.userId),
            isNull(dutyAssignments.endDate),
          ),
        )
        .limit(200),
      tx
        .select({
          cycleDay: cycleCalendar.cycleDay,
          isSchoolDay: cycleCalendar.isSchoolDay,
        })
        .from(cycleCalendar)
        .where(eq(cycleCalendar.date, today))
        .limit(1),
    ]);
    const [cycle] = cycleRows;

    const myUpcoming = allDuties.filter((duty) =>
      myAssignments.some((assignment) => assignment.dutyId === duty.id),
    ).length;

    const [groupRosterMap, recurringRows] = await Promise.all([
      getGroupDutyRoster({
        schoolId: session.schoolId,
        userId: session.userId,
      }),
      tx
        .select({
          id: recurringDuties.id,
          name: recurringDuties.name,
          location: recurringDuties.location,
          startTime: recurringDuties.startTime,
          endTime: recurringDuties.endTime,
          daysOfWeek: recurringDuties.daysOfWeek,
          assignedUserId: recurringDuties.assignedUserId,
          assignedUserName: users.name,
          requiresVest: recurringDuties.requiresVest,
          requiresRadio: recurringDuties.requiresRadio,
        })
        .from(recurringDuties)
        .leftJoin(users, eq(users.id, recurringDuties.assignedUserId))
        .where(
          and(
            eq(recurringDuties.schoolId, session.schoolId),
            eq(recurringDuties.isActive, true),
            or(
              eq(recurringDuties.assignedUserId, session.userId),
              isNull(recurringDuties.assignedUserId),
            ),
          ),
        )
        .orderBy(recurringDuties.startTime)
        .limit(20),
    ]);

    return {
      role: session.role,
      userId: session.userId,
      today,
      tomorrow,
      weekFromNow,
      allDuties,
      myAssignments,
      cycleDay: cycle?.cycleDay ?? null,
      isSchoolDay: cycle?.isSchoolDay ?? true,
      stats: {
        totalDuties: allDuties.length,
        totalLocations: new Set(allDuties.map((duty) => duty.location)).size,
        myUpcoming,
        myMinutesPerWeek: myUpcoming * 25,
      },
      groupRoster: Object.fromEntries(groupRosterMap),
      recurringDuties: recurringRows,
      showOnboardingBanner: isSoloSchool && myUpcoming === 0,
    };
  });

  const reminderMapRaw = await listRemindersForDuties(
    session.schoolId,
    data.allDuties.map((duty) => duty.id),
  );
  const reminderMap: Record<string, ReminderRow[]> = Object.fromEntries(
    reminderMapRaw,
  );

  return { ...data, reminderMap };
}
