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
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [testTargetUserId, setTestTargetUserId] = useState('');
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
      // No auto-navigate: the user has just read the success message + the
  // inserted/skipped counts. Auto-navigating after 1.5s lost their place.
  // They can click "Back to today" or "Import another" when ready.
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

  async function fireTestPush(targetUserId?: string): Promise<void> {
    setTestBusy(true);
    setTestResult(null);
    try {
      const r = await fetch('/api/notifications/test', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken ?? '',
        },
        body: JSON.stringify({
          ...(targetUserId ? { userId: targetUserId } : {}),
          title: 'Test push notification',
          body: 'If you see this, the dispatcher fanned out successfully (Web Push + APNs paths exercised).',
          linkUrl: '/app/today',
          kind: 'system.message',
        }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        targetUserId?: string;
        detail?: string;
      };
      if (r.ok && body.ok) {
        setTestResult({
          ok: true,
          detail: `Fired to ${body.targetUserId?.slice(0, 8) ?? '?'}...`,
        });
      } else {
        setTestResult({
          ok: false,
          detail: body.detail ?? body.error ?? `HTTP ${r.status}`,
        });
      }
    } catch (err) {
      setTestResult({
        ok: false,
        detail: err instanceof Error ? err.message : 'Network error',
      });
    } finally {
      setTestBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-center gap-3">
        <div className="flex items-center justify-between gap-2">
          <Link
            to="/app/today"
            className="text-sm text-secondary hover:underline"
          >
            <ArrowLeft className="inline h-4 w-4" /> Back to today
          </Link>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void fireTestPush()}
              disabled={testBusy}
              data-testid="fire-test-push"
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-primary hover:bg-surface-2 disabled:opacity-60"
            >
              {testBusy ? 'Firing...' : 'Fire test push'}
            </button>
          </div>
        </div>
        {testResult && (
          <p
            role="status"
            aria-live="polite"
            className={
              testResult.ok
                ? 'mt-2 text-xs text-green-700'
                : 'mt-2 text-xs text-error'
            }
          >
            {testResult.ok ? '✓ ' : '✗ '}
            {testResult.detail}
          </p>
        )}
        <details className="mt-2 text-xs text-secondary">
          <summary className="cursor-pointer hover:text-primary">
            Test on another user (admin only)
          </summary>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="text"
              inputMode="text"
              placeholder="User UUID (paste from Admin → Users)"
              value={testTargetUserId}
              onChange={(e) => setTestTargetUserId(e.target.value)}
              data-testid="fire-test-push-target-input"
              aria-describedby="fire-test-push-help"
              className="flex-1 rounded-md border border-border bg-surface px-2 py-1 font-mono text-footnote text-primary placeholder:text-secondary"
            />
            <button
              type="button"
              onClick={() => {
                const id = testTargetUserId.trim();
                if (!id) return;
                void fireTestPush(id);
              }}
              disabled={testBusy || !testTargetUserId.trim()}
              data-testid="fire-test-push-target"
              className="rounded-md border border-border bg-surface px-2 py-1 font-medium text-primary hover:bg-surface-2 disabled:opacity-60"
            >
              Fire
            </button>
          </div>
          <p id="fire-test-push-help" className="mt-1 text-footnote text-secondary">
            The target user must belong to your school. Users from
            another school can\'t be notified.
          </p>
        </details>
      </div>

      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <CalendarDays className="h-6 w-6" />
          Calendar import
        </h1>
        <p className="mt-2 text-sm text-secondary">
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
        <div className="rounded-lg border border-dashed border-border bg-surface p-8 text-center">
          <UploadCloud className="mx-auto h-10 w-10 text-secondary" />
          <h2 className="mt-3 font-medium">Upload your calendar PDF</h2>
          <p className="mt-1 text-sm text-secondary">
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
            <p className="mt-3 text-sm text-secondary">
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
        <section className="mt-8 rounded-lg border border-border bg-surface">
          <header className="border-b border-border px-5 py-3 flex items-center gap-2">
            <History className="h-4 w-4 text-secondary" />
            <h2 className="font-medium">Recent calendar imports</h2>
          </header>
          <ul className="divide-y divide-border">
            {recentCommits.map((r) => {
              // Map internal action slugs to plain English. Anything not
              // in the map falls back to a humanized version of the slug.
              const slug = r.action.replace(/^calendar_import\./, '');
              const label: Record<string, string> = {
                'upload_failed': 'Upload failed',
                'parse_failed': "Couldn't read the PDF",
                'commit_succeeded': 'Calendar saved',
                'commit_failed': 'Save failed',
                'rolled_back': 'Reverted',
              };
              const display = label[slug] ?? slug.replace(/_/g, ' ');
              const isError = slug.endsWith('failed');
              return (
                <li key={r.id} className="px-5 py-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className={isError ? 'text-error font-medium' : 'font-medium'}>
                      {display}
                    </span>
                    <time className="text-xs text-secondary">
                      {new Date(r.createdAt).toLocaleString()}
                    </time>
                  </div>
                  {r.metadata && (
                    <p className="mt-1 text-xs text-secondary">
                      {summarizeMetadata(r.metadata, 'processed')}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {showConfirm && parsed && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          className="fixed inset-0 z-50 grid place-items-center bg-black/50"
          onClick={(e) => {
            // Backdrop click closes the dialog (unless commit is in flight).
            if (e.target === e.currentTarget && !committing) {
              setShowConfirm(false);
            }
          }}
          onKeyDown={(e) => {
            // Esc closes the dialog.
            if (e.key === 'Escape' && !committing) setShowConfirm(false);
          }}
        >
          <div
            className="w-full max-w-md rounded-lg border border-border bg-surface p-6 shadow-xl"
            onKeyDown={(e) => {
              // Minimal focus trap: keep focus inside the dialog while open.
              if (e.key === 'Tab') {
                const focusable = e.currentTarget.querySelectorAll<HTMLElement>(
                  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
                );
                if (focusable.length === 0) return;
                const first = focusable[0]!;
                const last = focusable[focusable.length - 1]!;
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first.focus();
                }
              }
            }}
          >
            <h2 id="confirm-title" className="text-lg font-semibold">
              Save {parsed.summary.totalDays} days to your school calendar?
            </h2>
            <p className="mt-2 text-sm text-secondary">
              Existing days on the same dates will be updated. You can fix
              anything by re-uploading the PDF.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <Button
                variant="secondary"
                onClick={() => setShowConfirm(false)}
                disabled={committing}
                autoFocus
              >
                Cancel
              </Button>
              <Button onClick={() => void commit()} disabled={committing}>
                {committing ? 'Saving...' : 'Save'}
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
      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-medium">Summary</h2>
        <p className="mt-1 text-sm text-secondary">
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
          <summary className="cursor-pointer text-secondary">
            Per-code breakdown
          </summary>
          <ul className="mt-2 grid grid-cols-3 gap-1 text-xs">
            {Object.entries(summary.byCode).map(([code, count]) => (
              <li key={code} className="flex justify-between">
                <span className="text-secondary">{code}</span>
                <span>{count}</span>
              </li>
            ))}
          </ul>
        </details>
      </section>

      <section className="rounded-lg border border-border bg-surface">
        <header className="border-b border-border px-5 py-3">
          <h2 className="font-medium">Day-by-day</h2>
        </header>
        <div className="max-h-[420px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-2 text-xs uppercase text-secondary">
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
                      <span className="text-secondary">—</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {d.isInstructional ? (
                      <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">
                        Instructional
                      </span>
                    ) : (() => {
                      const glossary: Record<string, string> = {
                        'B': 'Board holiday / break',
                        'E': 'Elementary PA day',
                        'ES': 'Elementary / Secondary PA day',
                        'M': 'Mandatory holiday',
                        '0': 'Day-zero PA',
                      };
                      const code = d.holidayCode ?? 'Off';
                      const tip = d.holidayCode ? glossary[d.holidayCode] : null;
                      return (
                        <abbr
                          title={tip ?? code}
                          className="cursor-help rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800 no-underline"
                        >
                          {code}
                        </abbr>
                      );
                    })()}
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
          {committing ? 'Saving...' : 'Save to school calendar'}
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
  // Use design tokens (text-error / text-success / text-warning) instead of
  // raw Tailwind color classes — keeps the palette consistent with the
  // rest of the codebase and lets future theme swaps touch one token file.
  const toneClass =
    tone === 'green'
      ? 'text-success'
      : tone === 'amber'
      ? 'text-warning'
      : tone === 'red'
      ? 'text-error'
      : '';
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-secondary">
        {label}
      </dt>
      <dd className={`mt-0.5 text-2xl font-semibold ${toneClass}`}>
        {value}
      </dd>
    </div>
  );
}

function summarizeMetadata(metadata: Record<string, unknown>, verb = 'attempted'): string {
  const parts: string[] = [];
  if (typeof metadata.total === 'number') {
    parts.push(`${metadata.total} days`);
  }
  if (typeof metadata.attemptedRows === 'number' && metadata.attemptedRows > 0) {
    parts.push(`${metadata.attemptedRows} ${verb}`);
  }
  if (typeof metadata.error === 'string') {
    parts.push(`error: ${metadata.error.slice(0, 60)}`);
  }
  if (typeof metadata.durationMs === 'number') {
    parts.push(`${metadata.durationMs}ms`);
  }
  return parts.join(' • ');
}