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
//
// QA-swarm fixes (2026-07-05):
//   - S-U8 regression closed: error messages now use role="alert"
//     so screen readers announce them.
//   - B8 design-token drift closed: text-red-700 raw class swapped
//     for text-error token.
//   - H-cluster-2 BLOCKERs: added Confirm modal before commit
//     (destructive action), Cancel button to abandon a parsed
//     review, recent-commits panel showing last 5 audit_log rows.

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
  History,
  X,
} from 'lucide-react';

import type { Route } from './+types/admin.calendar._index';
import { getSession, requireRole } from '../../server/auth.server';
import { readCsrfCookie } from '../../server/csrf.server';
import { getSystemDb } from '../../server/db.server';
import { auditLog } from '@edusupervise/db';
import { desc, eq } from 'drizzle-orm';
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

interface RecentCommit {
  id: string;
  action: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
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
  try {
    requireRole(session, ['school_admin']);
  } catch {
    throw redirect('/app/today?denied=admin');
  }

  // Recent commits panel: last 5 calendar_import.* audit rows for this school.
  let recentCommits: RecentCommit[] = [];
  try {
    const db = getSystemDb();
    const rows = await db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        createdAt: auditLog.createdAt,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(eq(auditLog.schoolId, session.schoolId))
      .orderBy(desc(auditLog.createdAt))
      .limit(20);
    recentCommits = rows
      .filter((r) => r.action.startsWith('calendar_import.'))
      .slice(0, 5)
      .map((r) => ({
        id: String(r.id),
        action: r.action,
        createdAt:
          r.createdAt instanceof Date
            ? r.createdAt.toISOString()
            : String(r.createdAt),
        metadata:
          r.metadata && typeof r.metadata === 'object'
            ? (r.metadata as Record<string, unknown>)
            : null,
      }));
  } catch {
    // Audit log fetch failed — non-fatal, just hide the panel.
  }

  return {
    csrfToken: readCsrfCookie(request),
    recentCommits,
  };
}

export default function AdminCalendarPage() {
  const { csrfToken, recentCommits } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState<ImportResponse | null>(null);
  const [committing, setCommitting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
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
    try {
      const r = await fetch('/api/admin/calendar/import', {
        method: 'POST',
        body: fd,
        credentials: 'same-origin',
        headers: { 'x-csrf-token': csrfToken ?? '' },
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
        result?: { total: number; skipped: number; message: string };
      };
      if (!r.ok) {
        setError(String(body.message ?? body.error ?? 'Commit failed'));
        return;
      }
      setCommitted(
        body.result
          ? {
              inserted: body.result.total,
              skipped: body.result.skipped,
              message: body.result.message,
            }
          : null
      );
      setShowConfirm(false);
      setTimeout(() => navigate('/admin/calendar'), 1500);
    } catch (err) {
      setError('Network error — try again');
      console.error(err);
    } finally {
      setCommitting(false);
    }
  }

  function cancelReview(): void {
    // Abandon the parsed review without committing. Backs the user out
    // to the upload screen.
    setParsed(null);
    setError(null);
    setCommitted(null);
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
            <p
              role="alert"
              className="mt-3 text-sm text-error"
            >
              <AlertTriangle className="inline h-4 w-4" /> {error}
            </p>
          )}
        </div>
      ) : (
        <ReviewSection
          parsed={parsed}
          committing={committing}
          error={error}
          onCommit={() => setShowConfirm(true)}
          onCancel={cancelReview}
        />
      )}

      {recentCommits.length > 0 && !parsed && !committed && (
        <section className="mt-8 rounded-lg border border-border bg-card">
          <header className="border-b border-border px-5 py-3 flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-medium">Recent calendar imports</h2>
          </header>
          <ul className="divide-y divide-border">
            {recentCommits.map((r) => (
              <li key={r.id} className="px-5 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs">
                    {r.action.replace('calendar_import.', '')}
                  </span>
                  <time className="text-xs text-muted-foreground">
                    {new Date(r.createdAt).toLocaleString()}
                  </time>
                </div>
                {r.metadata && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {summarizeMetadata(r.metadata)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {showConfirm && parsed && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          className="fixed inset-0 z-50 grid place-items-center bg-black/50"
        >
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-xl">
            <h2 id="confirm-title" className="text-lg font-semibold">
              Commit calendar to cycle_calendar?
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              This will upsert {parsed.summary.totalDays} days into the
              school's calendar. Existing rows on the same dates will be
              updated. The action is reversible only by re-uploading.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <Button
                variant="secondary"
                onClick={() => setShowConfirm(false)}
                disabled={committing}
              >
                Cancel
              </Button>
              <Button onClick={() => void commit()} disabled={committing}>
                {committing ? 'Committing...' : 'Commit'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function ReviewSection({
  parsed,
  committing,
  error,
  onCommit,
  onCancel,
}: {
  parsed: ImportResponse;
  committing: boolean;
  error: string | null;
  onCommit: () => void;
  onCancel: () => void;
}): JSX.Element {
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
          <p role="alert" className="text-sm text-error">
            <AlertTriangle className="inline h-4 w-4" /> {error}
          </p>
        )}
        <Button
          variant="secondary"
          onClick={onCancel}
          disabled={committing}
        >
          <X className="inline h-4 w-4" /> Cancel
        </Button>
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
}): JSX.Element {
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

function summarizeMetadata(metadata: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof metadata.total === 'number') {
    parts.push(`${metadata.total} days`);
  }
  if (typeof metadata.attemptedRows === 'number' && metadata.attemptedRows > 0) {
    parts.push(`${metadata.attemptedRows} attempted`);
  }
  if (typeof metadata.error === 'string') {
    parts.push(`error: ${metadata.error.slice(0, 60)}`);
  }
  if (typeof metadata.durationMs === 'number') {
    parts.push(`${metadata.durationMs}ms`);
  }
  return parts.join(' • ');
}