// apps/web/app/routes/_app.calendar.print.tsx — printable weekly view.
//
// Designed for the staff room wall: A4 portrait, monospace, fits on one
// page per week. Hides nav, sidebar, and any UI chrome. Only renders
// the schedule grid + duty list.
//
// Render flow:
//   1. Loader fetches the current week's duties (Mon-Fri + Sat if any)
//      for the logged-in user's school
//   2. Groups by cycle day → ordered by start time
//   3. Renders as a 5-column grid with cycle-day colored headers
//
// Auto-print: appends window.print() on mount when ?print=1 is in the
// URL (the "Print this week" button on the calendar tab adds it).

import type { Route } from './+types/_app.calendar.print';
import { useEffect , useState } from 'react';
import { and, eq, gte, lte, asc } from 'drizzle-orm';
import { duties, dutyAssignments, cycleCalendar, schools, users } from '@edusupervise/db';
import { getSession } from '../../server/auth.server';
import { withSchoolId } from '../../server/db.server';
import { cycleDayClasses, cycleDaySoftClasses } from '../components/ui/CycleLegend';

export function meta() {
  return [{ title: 'Print — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (!session) {
    throw new Response(null, {
      status: 302,
      headers: { Location: '/login' },
    });
  }

  // Compute week range (Mon-Sun) for the school's timezone. Use the
  // same Intl.DateTimeFormat trick as /app/today — server is UTC,
  // school may not be.
  const tzUrl = process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!tzUrl) {
    return { school: null, week: [], weekStart: null, weekEnd: null };
  }
  const { getSystemClient } = await import('@edusupervise/db');
  const { db: sysDb, close: sysClose } = getSystemClient(tzUrl);
  let tz = 'America/Toronto';
  try {
    const [s] = await sysDb
      .select({ timezone: schools.timezone })
      .from(schools)
      .where(eq(schools.id, session.schoolId))
      .limit(1);
    tz = s?.timezone ?? tz;
  } finally {
    await sysClose();
  }

  // Server-side loader: new Date() is safe here. Hydration mismatch
  // was from the JSX render in the default export (new Date().toLocaleString()),
  // not the loader — the loader runs in the SSR phase only.
  const now = new Date();
  const todayStr = formatDateInTz(now, tz);
  const todayDate = new Date(todayStr + 'T00:00:00');

  // Find this week's Monday (or Sunday if Sunday-start locale — North
  // American schools use Monday-start, so we hard-code that here).
  const dow = todayDate.getDay(); // 0=Sun, 1=Mon, ...
  const daysSinceMon = (dow + 6) % 7;
  const monday = new Date(todayDate.getTime() - daysSinceMon * 86_400_000);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  const mondayStr = formatDateInTz(monday, tz);
  const sundayStr = formatDateInTz(sunday, tz);

  const data = await withSchoolId(session.schoolId, async (tx) => {
    const school = await tx
      .select({ name: schools.name })
      .from(schools)
      .where(eq(schools.id, session.schoolId))
      .limit(1);

    const calendarRows = await tx
      .select({
        date: cycleCalendar.date,
        cycleDay: cycleCalendar.cycleDay,
        isSchoolDay: cycleCalendar.isSchoolDay,
      })
      .from(cycleCalendar)
      .where(and(
        gte(cycleCalendar.date, mondayStr),
        lte(cycleCalendar.date, sundayStr),
      ))
      .orderBy(asc(cycleCalendar.date));

    const dutyRows = await tx
      .select({
        id: duties.id,
        location: duties.location,
        description: duties.description,
        startTime: duties.startTime,
        endTime: duties.endTime,
        cycleDay: duties.cycleDay,
        requiresVest: duties.requiresVest,
        requiresRadio: duties.requiresRadio,
        assigneeName: users.name,
      })
      .from(duties)
      .leftJoin(
        dutyAssignments,
        and(
          eq(dutyAssignments.dutyId, duties.id),
          // active assignments only (end_date IS NULL)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (dutyAssignments.endDate as any).isNull?.() ?? undefined,
        ),
      )
      .leftJoin(users, eq(users.id, dutyAssignments.userId))
      .where(eq(duties.isActive, true))
      .orderBy(asc(duties.cycleDay), asc(duties.startTime));

    return {
      schoolName: school[0]?.name ?? 'School',
      calendar: calendarRows,
      duties: dutyRows,
    };
  });

  return {
    schoolName: data.schoolName,
    schoolTimezone: tz,
    weekStart: mondayStr,
    weekEnd: sundayStr,
    calendar: data.calendar,
    duties: data.duties,
  };
}

export default function PrintView({ loaderData }: Route.ComponentProps) {
  const [printTime, setPrintTime] = useState('');
  useEffect(() => { setPrintTime(new Date().toLocaleString()); }, []);
  const { schoolName, weekStart, weekEnd, calendar, duties } = loaderData;

  // Group calendar rows by cycle day for the column headers.
  const calByDay = new Map<number, { date: string; isSchoolDay: boolean }>();
  for (const row of calendar) {
    calByDay.set(row.cycleDay, { date: row.date, isSchoolDay: row.isSchoolDay });
  }

  // Group duties by cycle day.
  const dutiesByDay = new Map<number, typeof duties>();
  for (const d of duties) {
    const list = dutiesByDay.get(d.cycleDay) ?? [];
    list.push(d);
    dutiesByDay.set(d.cycleDay, list);
  }

  // Auto-trigger print when ?print=1 in the URL.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('print') === '1') {
      // Give the layout a tick to render before opening the dialog.
      const t = setTimeout(() => window.print(), 250);
      return () => clearTimeout(t);
    }
  }, []);

  const days = [1, 2, 3, 4, 5];
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const dayDates: string[] = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(weekStart + 'T00:00:00');
    d.setDate(d.getDate() + i);
    dayDates.push(`${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getDate()}`);
  }

  return (
    <div className="print-page bg-white text-black p-lg max-w-[210mm] mx-auto" style={{ minHeight: '297mm' }}>
      {/* Header */}
      <header className="border-b-2 border-black pb-md mb-lg">
        <h1 className="text-2xl font-bold leading-tight">{schoolName}</h1>
        <p className="text-sm text-gray-700 mt-xs">
          Supervision Schedule — week of {formatHumanDate(weekStart)} – {formatHumanDate(weekEnd)}
        </p>
      </header>

      {/* Grid: 5 columns, one per cycle day */}
      <div className="grid grid-cols-5 gap-xs mb-lg" style={{ pageBreakInside: 'avoid' }}>
        {days.map((day, idx) => {
          const cal = calByDay.get(day);
          const dayDuties = dutiesByDay.get(day) ?? [];
          return (
            <div key={day} className="border border-gray-400 rounded-sm p-xs">
              <div className={`text-xs font-bold uppercase tracking-wide mb-xs px-xs py-xs rounded ${cycleDaySoftClasses(day)}`}>
                Day {day} · {dayLabels[idx]}
              </div>
              <div className="text-xs text-gray-600 mb-xs">
                {dayDates[idx] ?? ''}
              </div>
              {!cal?.isSchoolDay ? (
                <p className="text-xs italic text-gray-500 mt-xs">No school</p>
              ) : dayDuties.length === 0 ? (
                <p className="text-xs italic text-gray-500 mt-xs">No duties</p>
              ) : (
                <ul className="space-y-xs">
                  {dayDuties.map((d) => (
                    <li key={d.id} className="text-xs leading-tight">
                      <div className="font-semibold tabular">
                        {formatTime12h(d.startTime)}–{formatTime12h(d.endTime)}
                      </div>
                      <div className="font-medium">{d.location}</div>
                      {d.assigneeName && (
                        <div className="text-gray-700">→ {d.assigneeName}</div>
                      )}
                      {(d.requiresVest || d.requiresRadio) && (
                        <div className="text-gray-600 mt-xs">
                          {d.requiresVest && <span className="mr-xs">[Vest]</span>}
                          {d.requiresRadio && <span>[Radio]</span>}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer notes */}
      <footer className="mt-xl pt-md border-t border-gray-300 text-xs text-gray-700">
        <p>
          Printed from EduSupervise —{' '}
          <span className="font-mono" suppressHydrationWarning>{printTime || '—'}</span>
        </p>
        <p className="mt-xs">
          Sub coverage: visit <span className="font-mono">edusupervise.ashbi.ca/app/coverage</span> or
          ask the office.
        </p>
      </footer>

      {/* Print-specific CSS — hidden on screen, shown on print */}
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 12mm; }
          body { background: white !important; }
          .print-page { padding: 0 !important; max-width: none !important; }
          nav, aside, header.app-header { display: none !important; }
        }
        @media screen {
          body { background: #F1F3F7; }
          .print-page { box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
        }
      `}</style>
    </div>
  );
}

function formatTime12h(hhmm: string | null | undefined): string {
  if (!hhmm) return '—';
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function formatHumanDate(yyyymmdd: string): string {
  const d = new Date(yyyymmdd + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateInTz(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}