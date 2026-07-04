// apps/web/app/routes/onboarding.pdf-review._index.tsx
//
// Phase 2 — PDF review card.
//
// Loader fetches the parsed rows from Redis (key `pdf:{jobId}`); the
// upload endpoint stored them there 24h ago (or just now).
//
// UI:
//   - Header: cycle length, parse duration, "X rows" count, SHA-256
//     prefix so the user knows what got parsed.
//   - Editable table: one row per parsed duty, columns for
//     cycleDay | teacherName | role | start | end | location.
//   - Each cell is an inline `<input>` / `<select>`. Edits are
//     kept in component state and POSTed on confirm.
//   - Bottom: "Save and continue" → POSTs to
//     /api/onboarding/confirm-pdf with the full edited row set.
//   - "Cancel" → returns to /onboarding/solo (or wherever the
//     teacher came from).
//
// Failure UX:
//   - job_not_found / expired: redirect back to /onboarding/solo
//     with a flash message; the user re-uploads.
//   - parse failed: show the parse-failure message + a link to
//     upload a different PDF.
//
// Empty cells (the "--" placeholder in Jason's PDF) are preserved:
// the user sees an editable empty cell and can leave it blank (the
// confirm step will write the duty with no assignment). This matches
// Cameron's hard rule: "Empty cells preserved as unassigned, not
// auto-filled".

import { useMemo, useState } from 'react';
import { redirect, useLoaderData, useNavigate, Link } from 'react-router';
import { ArrowLeft, ArrowRight, CheckCircle2, FileText, AlertTriangle } from 'lucide-react';

import type { Route } from './+types/onboarding.pdf-review._index';
import { getSession } from '../../server/auth.server';
import { cacheRead } from '../../server/pdf-parser.server';
import { readCsrfCookie } from '../../server/csrf.server';
import { Button } from '../components/ui';

export function meta() {
  return [{ title: 'Review your PDF — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (!session) {
    throw redirect('/login');
  }
  const url = new URL(request.url);
  const jobId = url.searchParams.get('jobId');
  if (!jobId) {
    throw redirect('/onboarding/solo?error=missing_job_id');
  }

  const outcome = await cacheRead(jobId);

  if (!outcome) {
    // Job expired (>24h) or never existed. Send the teacher back to
    // re-upload. We DON'T auto-redirect with a query param because
    // the solo wizard reads `?error=` only as a flash on first paint.
    throw redirect('/onboarding/solo?error=pdf_expired');
  }

  if (!outcome.ok) {
    // The parse failed. Render the failure inline so the user can
    // see WHY we couldn't parse their PDF.
    return {
      kind: 'parse_failed' as const,
      jobId,
      csrfToken: readCsrfCookie(request),
      code: outcome.code,
      message: outcome.message,
      sha256: outcome.sha256,
    };
  }

  // Success path: hand the parsed rows to the UI.
  return {
    kind: 'parse_ok' as const,
    jobId,
    csrfToken: readCsrfCookie(request),
    cycleLength: outcome.cycleLength,
    rowCount: outcome.rows.length,
    durationMs: outcome.durationMs,
    sha256: outcome.sha256,
    rows: outcome.rows.map((r, i) => ({
      id: `r${i}`,
      kind: r.kind,
      cycleDay: r.cycleDay,
      teacherName: r.teacherName ?? '',
      role: r.role,
      startTime: r.startTime,
      endTime: r.endTime,
      location: r.location,
      notes: r.notes ?? '',
    })),
  };
}

type EditableRow = {
  id: string;
  cycleDay: number | null;
  teacherName: string;
  role: 'teacher' | 'educational_assistant' | null;
  startTime: string;
  endTime: string;
  location: string;
  notes: string;
};

export default function PdfReview() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (data.kind === 'parse_failed') {
    return <ParseFailedView code={data.code} message={data.message} jobId={data.jobId} />;
  }

  return (
    <ParseOkView
      data={data}
      submitting={submitting}
      setSubmitting={setSubmitting}
      error={error}
      setError={setError}
      navigate={navigate}
    />
  );
}

// ---------------------------------------------------------------------------
// Parse-failed render
// ---------------------------------------------------------------------------

function ParseFailedView({
  code,
  message,
  jobId,
}: {
  code: string;
  message: string;
  jobId: string;
}) {
  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center p-md">
      <div className="max-w-md w-full bg-surface rounded-xl border border-border shadow-elev-1 p-2xl space-y-md">
        <div className="mx-auto w-16 h-16 rounded-full bg-warning-soft grid place-items-center">
          <AlertTriangle size={32} className="text-warning" aria-hidden />
        </div>
        <h1 className="text-title-1 text-primary font-bold text-center">
          Couldn't read that PDF
        </h1>
        <p className="text-callout text-secondary text-center">{message}</p>
        <p className="text-footnote text-tertiary text-center">
          Code: <code className="font-mono">{code}</code> · job <code className="font-mono">{jobId.slice(0, 8)}</code>
        </p>
        <div className="flex gap-sm pt-md">
          <Button
            variant="secondary"
            size="md"
            onClick={() => {
              window.location.href = '/onboarding/solo';
            }}
          >
            <ArrowLeft size={18} aria-hidden />
            Try another PDF
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              window.location.href = '/onboarding/solo?skip=1';
            }}
          >
            Add duties manually
            <ArrowRight size={18} aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Parse-OK render
// ---------------------------------------------------------------------------

function ParseOkView({
  data,
  submitting,
  setSubmitting,
  error,
  setError,
  navigate,
}: {
  data: Extract<ReturnType<typeof useLoaderData<typeof loader>>, { kind: 'parse_ok' }>;
  submitting: boolean;
  setSubmitting: (v: boolean) => void;
  error: string | null;
  setError: (v: string | null) => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const [rows, setRows] = useState<EditableRow[]>(data.rows);

  // Group rows by cycle day for the column header rendering.
  const days = useMemo(() => {
    const set = new Set<number>();
    for (const r of rows) {
      if (r.cycleDay) set.add(r.cycleDay);
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [rows]);

  function update(id: string, patch: Partial<EditableRow>) {
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function removeRow(id: string) {
    setRows((cur) => cur.filter((r) => r.id !== id));
  }

  function addRow() {
    setRows((cur) => [
      ...cur,
      {
        id: `new-${Date.now()}`,
        cycleDay: (days[days.length - 1] ?? 1) + 1,
        teacherName: '',
        role: 'teacher',
        startTime: '08:45',
        endTime: '09:00',
        location: 'Front doors',
        notes: '',
      },
    ]);
  }

  async function confirm() {
    setError(null);
    setSubmitting(true);
    try {
      const csrf = getCookie('__Host-edusupervise.csrf');
      const idempotencyKey = `pdf-confirm-${data.jobId}`;
      const res = await fetch('/api/onboarding/confirm-pdf', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          jobId: data.jobId,
          rows: rows.map((r) => ({
            cycleDay: r.cycleDay,
            teacherName: r.teacherName || null,
            role: r.role,
            startTime: r.startTime,
            endTime: r.endTime,
            location: r.location,
            notes: r.notes || null,
          })),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      // Success: navigate to /app/today with a flash query param.
      navigate('/app/today?from=pdf');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      {/* Header */}
      <header className="bg-surface border-b border-divider px-md py-md">
        <div className="max-w-3xl mx-auto flex items-start justify-between gap-md">
          <div>
            <div className="flex items-center gap-sm text-secondary">
              <FileText size={18} aria-hidden />
              <span className="text-footnote font-medium">PDF parsed</span>
            </div>
            <h1 className="text-title-1 text-primary font-bold mt-xs">
              Review {data.rowCount} {data.rowCount === 1 ? 'row' : 'rows'}
            </h1>
            <p className="text-callout text-secondary mt-xs">
              Cycle length: {data.cycleLength} days · Parsed in {data.durationMs} ms
            </p>
            <p className="text-footnote text-tertiary mt-xs">
              sha256 <code className="font-mono">{data.sha256.slice(0, 12)}…</code>
            </p>
          </div>
          <Link
            to="/onboarding/solo"
            className="text-callout text-secondary hover:text-primary"
          >
            Cancel
          </Link>
        </div>
      </header>

      {/* Day summary strip */}
      {days.length > 0 && (
        <div className="bg-surface-2 border-b border-divider px-md py-sm">
          <div className="max-w-3xl mx-auto flex items-center gap-md overflow-x-auto">
            <span className="text-footnote text-tertiary font-medium uppercase tracking-wide">
              Days detected
            </span>
            {days.map((d) => (
              <span
                key={d}
                className="inline-flex items-center gap-xs px-sm py-xs bg-accent-soft text-accent rounded-sm text-footnote font-semibold"
              >
                Day {d}
                <span className="text-tertiary font-normal">
                  · {rows.filter((r) => r.cycleDay === d).length}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Body */}
      <main className="flex-1 px-md py-xl">
        <div className="max-w-3xl mx-auto space-y-md">
          {error && (
            <div className="bg-error-soft text-error rounded-md p-md text-callout border border-error/30">
              <strong>Couldn't save:</strong> {error}
            </div>
          )}

          <div className="bg-surface rounded-xl border border-border shadow-elev-1 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-surface-2 text-footnote uppercase tracking-wide text-secondary">
                  <th className="text-left px-md py-sm w-20">Day</th>
                  <th className="text-left px-md py-sm">Teacher</th>
                  <th className="text-left px-md py-sm w-32">Role</th>
                  <th className="text-left px-md py-sm w-28">Start</th>
                  <th className="text-left px-md py-sm w-28">End</th>
                  <th className="text-left px-md py-sm">Location</th>
                  <th className="w-12" aria-label="Remove"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divider">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-md py-sm align-top">
                      <select
                        value={r.cycleDay ?? 1}
                        onChange={(e) =>
                          update(r.id, { cycleDay: parseInt(e.target.value, 10) })
                        }
                        className="w-full h-9 px-sm bg-surface border border-border rounded-sm text-callout focus:outline-none focus:ring-2 focus:ring-accent"
                        aria-label="Cycle day"
                      >
                        {Array.from({ length: data.cycleLength }).map((_, i) => (
                          <option key={i + 1} value={i + 1}>
                            {i + 1}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-md py-sm align-top">
                      <input
                        type="text"
                        value={r.teacherName}
                        placeholder="(unassigned)"
                        onChange={(e) => update(r.id, { teacherName: e.target.value })}
                        className="w-full h-9 px-sm bg-surface border border-border rounded-sm text-callout focus:outline-none focus:ring-2 focus:ring-accent"
                      />
                    </td>
                    <td className="px-md py-sm align-top">
                      <select
                        value={r.role ?? ''}
                        onChange={(e) =>
                          update(r.id, {
                            role:
                              e.target.value === 'teacher' ||
                              e.target.value === 'educational_assistant'
                                ? e.target.value
                                : null,
                          })
                        }
                        className="w-full h-9 px-sm bg-surface border border-border rounded-sm text-callout focus:outline-none focus:ring-2 focus:ring-accent"
                        aria-label="Role"
                      >
                        <option value="">(none)</option>
                        <option value="teacher">Teacher</option>
                        <option value="educational_assistant">EA</option>
                      </select>
                    </td>
                    <td className="px-md py-sm align-top">
                      <input
                        type="time"
                        value={r.startTime}
                        onChange={(e) => update(r.id, { startTime: e.target.value })}
                        className="w-full h-9 px-sm bg-surface border border-border rounded-sm text-callout focus:outline-none focus:ring-2 focus:ring-accent tabular"
                      />
                    </td>
                    <td className="px-md py-sm align-top">
                      <input
                        type="time"
                        value={r.endTime}
                        onChange={(e) => update(r.id, { endTime: e.target.value })}
                        className="w-full h-9 px-sm bg-surface border border-border rounded-sm text-callout focus:outline-none focus:ring-2 focus:ring-accent tabular"
                      />
                    </td>
                    <td className="px-md py-sm align-top">
                      <input
                        type="text"
                        value={r.location}
                        onChange={(e) => update(r.id, { location: e.target.value })}
                        className="w-full h-9 px-sm bg-surface border border-border rounded-sm text-callout focus:outline-none focus:ring-2 focus:ring-accent"
                      />
                    </td>
                    <td className="px-sm py-sm align-top text-center">
                      <button
                        type="button"
                        onClick={() => removeRow(r.id)}
                        aria-label="Remove row"
                        className="text-tertiary hover:text-error transition-colors"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-md py-sm border-t border-divider bg-surface-2">
              <button
                type="button"
                onClick={addRow}
                className="text-callout text-accent font-semibold hover:underline"
              >
                + Add row
              </button>
            </div>
          </div>

          <div className="text-footnote text-tertiary">
            Empty cells are saved as <em>unassigned</em> duties. You can edit any
            cell before confirming.
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-surface border-t border-divider px-md py-md">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <Link
            to="/onboarding/solo"
            className="text-callout text-secondary hover:text-primary"
          >
            <ArrowLeft size={18} aria-hidden className="inline mr-xs" />
            Back
          </Link>
          <Button
            variant="primary"
            size="md"
            onClick={confirm}
            disabled={submitting || rows.length === 0}
          >
            {submitting ? (
              'Saving…'
            ) : (
              <>
                <CheckCircle2 size={18} aria-hidden />
                Save and continue
                <ArrowRight size={18} aria-hidden />
              </>
            )}
          </Button>
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const cookies = document.cookie ? document.cookie.split(';') : [];
  for (const pair of cookies) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const k = pair.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(pair.slice(eq + 1).trim());
  }
  return null;
}