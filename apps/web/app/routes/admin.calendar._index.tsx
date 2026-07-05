import * as React from 'react';

// apps/web/app/routes/admin.calendar._index.tsx —
// Phase 3 admin UI for uploading + reviewing + committing a school
// calendar PDF. Two-step flow:
//   1. Upload PDF → /api/admin/calendar/import (returns parsed days).
//   2. Review summary + per-day table → POST /api/admin/calendar/commit.
//
// UX mirrors onboarding.upload-pdf + onboarding.pdf-review but lives
// under /admin/calendar so it's reachable post-onboarding for any
// future calendar change (district calendar revisions, mid-year
// schedule shifts).
//
// Auth: requires school_admin role. Loader enforces this; UI shows
// "no access" if the role check fails (defense-in-depth; the API
// also requires school_admin).

import { useState } from 'react';
import {
  redirect,
  useLoaderData,
  useNavigate,
  Link,
} from 'react-router';
import {
  UploadCloud,
  FileText,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CalendarDays,
} from 'lucide-react';

import type { Route } from './+types/admin.calendar._index';
import { getSession, requireRole } from '../../server/auth.server';
import { readCsrfCookie } from '../../server/csrf.server';
import { Button } from '../components/ui';

interface ParsedDay {
  date: string;
  month: number;
  day: number;
  weekday: string;
  cycleDay: number | null;
  isInstructional: boolean;
  holidayCode: string | null;
}

interface ImportResponse {
  jobId: string;
  sha256: string;
  calendarTitle: string;
  schoolYear: string;
  days: ParsedDay[];
  summary: {
    totalDays: number;
    instructionalDays: number;
    paDays: number;
    mandatoryHolidays: number;
    byCode: Record<string, number>;
  };
  durationMs: number;
}

const MAX_BYTES = 10 * 1024 * 1024;

export function meta() {
  return [{ title: 'Calendar import — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (!session) {
    throw redirect('/login?next=' + encodeURIComponent('/admin/calendar'));
  }
  // Defense-in-depth: even if the route is hit, requireRole throws a
  // 403 Response if the user isn't a school_admin. Catch that and
  // redirect to /app/today with a flash.
  try {
    requireRole(session, ['school_admin']);
  } catch {
    throw redirect('/app/today?denied=admin');
  }
  return { csrfToken: readCsrfCookie(request) };
}

export default function AdminCalendarPage() {
  const { csrfToken } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState<ImportResponse | null>(null);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState<{
    inserted: number;
    skipped: number;
    message: string;
  } | null>(null);

  async function uploadAndParse(f: File): Promise<void> {
    setBusy(true);
    setError(null);
    setParsed(null);
    setCommitted(null);
    const fd = new FormData();
    fd.append('file', f);
    if (csrfToken) fd.append('csrfToken', csrfToken);
    try {
      const r = await fetch('/api/admin/calendar/import', {
        method: 'POST',
        body: fd,
        credentials: 'same-origin',
      });
      const body = (await r.json()) as Record<string, unknown> & {
        days?: ParsedDay[];
        summary?: ImportResponse['summary'];
        jobId?: string;
      };
      if (!r.ok) {
        setError(String(body.message ?? body.error ?? 'Upload failed'));
        return;
      }
      setParsed(body as unknown as ImportResponse);
    } catch (err) {
      setError('Network error — try again');
      console.error(err);
    } finally {
      setBusy(false);
    }
  }

  async function commit(): Promise<void> {
    if (!parsed) return;
    setCommitting(true);
    setError(null);
    try {
      const r = await fetch('/api/admin/calendar/commit', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken ?? '',
        },
        body: JSON.stringify({ jobId: parsed.jobId, confirm: true }),
      });
      const body = (await r.json()) as Record<string, unknown> & {
        result?: { inserted: number; skipped: number; message: string };
      };
      if (!r.ok) {
        setError(String(body.message ?? body.error ?? 'Commit failed'));
        return;
      }
      setCommitted(body.result ?? null);
      // Refresh the page after a moment so the user can do another import.
      setTimeout(() => navigate('/admin/calendar'), 1500);
    } catch (err) {
      setError('Network error — try again');
      console.error(err);
    } finally {
      setCommitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-center gap-3">
        <Link
          to="/app/today"
          className="text-sm text-muted-foreground hover:underline"
        >
          <ArrowLeft className="inline h-4 w-4" /> Back to today
        </Link>
      </div>

      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <CalendarDays className="h-6 w-6" />
          Calendar import
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Upload your school calendar PDF. We'll extract each day and
          mark which ones are instructional (duties fire) vs holidays
          (duties pause). Review the summary, then commit.
        </p>
      </header>

      {committed ? (
        <div className="rounded-lg border border-green-200 bg-green-50 p-6 text-green-900">
          <CheckCircle2 className="inline h-5 w-5" />
          <span className="ml-2 font-medium">Imported successfully</span>
          <p className="mt-2 text-sm">{committed.message}</p>
        </div>
      ) : !parsed ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center">
          <UploadCloud className="mx-auto h-10 w-10 text-muted-foreground" />
          <h2 className="mt-3 font-medium">Upload your calendar PDF</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            5-day cycle elementary template (YRDSB). Max {MAX_BYTES / 1024 / 1024}MB.
          </p>
          <input
            type="file"
            accept="application/pdf"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setFile(f);
              void uploadAndParse(f);
            }}
            className="mx-auto mt-4 block text-sm"
          />
          {busy && (
            <p className="mt-3 text-sm text-muted-foreground">
              <FileText className="inline h-4 w-4" /> Parsing...
            </p>
          )}
          {error && (
            <p className="mt-3 text-sm text-red-700">
              <AlertTriangle className="inline h-4 w-4" /> {error}
            </p>
          )}
        </div>
      ) : (
        <ReviewSection
          parsed={parsed}
          committing={committing}
          error={error}
          onCommit={commit}
        />
      )}
    </main>
  );
}

function ReviewSection({
  parsed,
  committing,
  error,
  onCommit,
}: {
  parsed: ImportResponse;
  committing: boolean;
  error: string | null;
  onCommit: () => void;
}): React.ReactElement {
  const { summary, days, calendarTitle, schoolYear, durationMs } = parsed;
  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="font-medium">Summary</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {calendarTitle || 'School calendar'} • Year {schoolYear} •
          Parsed in {durationMs}ms
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label="Total days" value={summary.totalDays} />
          <Stat
            label="Instructional"
            value={summary.instructionalDays}
            tone="green"
          />
          <Stat label="PA days" value={summary.paDays} tone="amber" />
          <Stat
            label="Mandatory holidays"
            value={summary.mandatoryHolidays}
            tone="red"
          />
        </dl>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Per-code breakdown
          </summary>
          <ul className="mt-2 grid grid-cols-3 gap-1 text-xs">
            {Object.entries(summary.byCode).map(([code, count]) => (
              <li key={code} className="flex justify-between">
                <span className="text-muted-foreground">{code}</span>
                <span>{count}</span>
              </li>
            ))}
          </ul>
        </details>
      </section>

      <section className="rounded-lg border border-border bg-card">
        <header className="border-b border-border px-5 py-3">
          <h2 className="font-medium">Day-by-day</h2>
        </header>
        <div className="max-h-[420px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Weekday</th>
                <th className="px-3 py-2 text-left">Cycle</th>
                <th className="px-3 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr
                  key={d.date}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-3 py-1.5 font-mono text-xs">
                    {d.date}
                  </td>
                  <td className="px-3 py-1.5">{d.weekday}</td>
                  <td className="px-3 py-1.5">
                    {d.cycleDay ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {d.isInstructional ? (
                      <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">
                        Instructional
                      </span>
                    ) : (
                      <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                        {d.holidayCode ?? 'Off'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="flex items-center justify-end gap-3">
        {error && (
          <p className="text-sm text-red-700">
            <AlertTriangle className="inline h-4 w-4" /> {error}
          </p>
        )}
        <Button onClick={onCommit} disabled={committing}>
          {committing ? 'Committing...' : 'Commit to cycle_calendar'}
        </Button>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'green' | 'amber' | 'red';
}): React.ReactElement {
  const toneClass =
    tone === 'green'
      ? 'text-green-700'
      : tone === 'amber'
      ? 'text-amber-700'
      : tone === 'red'
      ? 'text-red-700'
      : '';
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className={`mt-0.5 text-2xl font-semibold ${toneClass}`}>
        {value}
      </dd>
    </div>
  );
}