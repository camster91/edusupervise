// apps/web/app/routes/onboarding.upload-pdf._index.tsx
//
// Phase 2 — PDF upload entry point. Audit B9 (2026-07-04) flagged that
// /api/onboarding/upload-pdf existed but had no client UI to call it;
// this route is the missing link. Spec section 2.1 / 2.3 says "After
// upload, redirect to /onboarding/pdf-review?jobId=..." — that's the
// contract this page fulfils.
//
// UX:
//   - "Drop a PDF here or click to choose"
//   - 10MB cap, PDF only (server-side check matches the upload route)
//   - POST goes to /api/onboarding/upload-pdf via fetch (multipart);
//     on success we redirect to /onboarding/pdf-review?jobId=...
//   - On failure we render the error message from the server
//     (one of: too_small, unsupported_media_type, scanned_pdf,
//     too_large, parse_failed, rate_limited, server_error).
//
// Auth: this route is for authenticated onboarding users. Unauthed
// visitors are redirected to /login?next=/onboarding/upload-pdf.

import { useState } from 'react';
import { redirect, useLoaderData, useNavigate, Link } from 'react-router';
import { UploadCloud, FileText, AlertTriangle, ArrowLeft } from 'lucide-react';

import type { Route } from './+types/onboarding.upload-pdf._index';
import { getSession } from '../../server/auth.server';
import { readCsrfCookie } from '../../server/csrf.server';
import { Button } from '../components/ui';

export function meta() {
  return [{ title: 'Upload your duty PDF — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (!session) {
    throw redirect('/login?next=' + encodeURIComponent('/onboarding/upload-pdf'));
  }
  return { csrfToken: readCsrfCookie(request) };
}

const MAX_BYTES = 10 * 1024 * 1024; // matches the server-side cap

export default function UploadPdfPage() {
  const { csrfToken } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function onPick(f: File | null) {
    setError(null);
    if (!f) {
      setFile(null);
      return;
    }
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      setError('Please choose a PDF file.');
      return;
    }
    if (f.size > MAX_BYTES) {
      setError(`File is too large. Max 10MB (your file is ${(f.size / 1024 / 1024).toFixed(1)}MB).`);
      return;
    }
    if (f.size < 100) {
      setError('File is too small to be a valid PDF.');
      return;
    }
    setFile(f);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file) {
      setError('Choose a PDF first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      if (!csrfToken) { setError('Session expired \u2014 reload the page.'); setBusy(false); return; }
      form.append('csrf', csrfToken);
      const res = await fetch('/api/onboarding/upload-pdf', {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        setError(body.message ?? body.error ?? `Upload failed (HTTP ${res.status}).`);
        setBusy(false);
        return;
      }
      const data = (await res.json()) as { jobId?: string; status?: string };
      if (!data.jobId) {
        setError('Upload succeeded but no jobId returned. Please try again.');
        setBusy(false);
        return;
      }
      // Redirect to the review page — the contract from spec 2.3.
      navigate(`/onboarding/pdf-review?jobId=${encodeURIComponent(data.jobId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error during upload.');
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-bg px-md py-2xl">
      <div className="max-w-2xl mx-auto">
        <Link
          to="/app/today"
          className="inline-flex items-center gap-xs text-callout text-secondary hover:text-primary mb-lg"
        >
          <ArrowLeft size={16} aria-hidden />
          Back to Today
        </Link>

        <header className="mb-xl">
          <h1 className="text-title-1 text-primary font-bold">
            Upload your duty schedule PDF
          </h1>
          <p className="text-callout text-secondary mt-sm">
            Drop in the 5-day rotation PDF from your school board or admin. We read
            the schedule in under a second, you confirm the rows, and your reminders
            start firing the same day.
          </p>
        </header>

        <form
          onSubmit={onSubmit}
          className="bg-surface rounded-2xl border border-border shadow-elev-1 p-xl space-y-md"
        >
          <label
            htmlFor="pdf-file"
            className="flex flex-col items-center justify-center gap-sm border-2 border-dashed border-border rounded-xl py-2xl px-md cursor-pointer hover:border-accent hover:bg-surface-2 transition-colors duration-base"
          >
            <UploadCloud size={48} aria-hidden className="text-secondary" />
            {file ? (
              <div className="flex items-center gap-xs text-callout text-primary">
                <FileText size={18} aria-hidden />
                <span className="font-semibold">{file.name}</span>
                <span className="text-secondary">
                  ({(file.size / 1024).toFixed(0)} KB)
                </span>
              </div>
            ) : (
              <div className="text-center">
                <div className="text-callout text-primary font-semibold">
                  Click to choose a PDF
                </div>
                <div className="text-footnote text-secondary mt-xs">
                  or drop one here — max 10MB
                </div>
              </div>
            )}
            <input
              id="pdf-file"
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              onChange={(e) => onPick(e.currentTarget.files?.[0] ?? null)}
            />
          </label>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-sm text-callout text-error rounded-md bg-error-soft px-md py-sm"
            >
              <AlertTriangle size={18} aria-hidden className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-sm">
            <Link to="/app/today">
              <Button variant="secondary" size="md" type="button">
                Cancel
              </Button>
            </Link>
            <Button
              variant="primary"
              size="md"
              type="submit"
              disabled={busy || !file}
            >
              {busy ? 'Uploading…' : 'Parse schedule'}
            </Button>
          </div>

          <p className="text-footnote text-tertiary">
            Your PDF stays in your school's tenant. We never share schedule
            data between schools.
          </p>
        </form>
      </div>
    </main>
  );
}