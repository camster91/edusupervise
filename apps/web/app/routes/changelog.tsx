// apps/web/app/routes/changelog.tsx — public changelog / release timeline.
//
// Reads the prebuilt JSON at apps/web/app/data/changelog.json (refreshed
// on every web build via the prebuild hook in package.json). No auth —
// this is a public page so App Store reviewers, prospects, and existing
// users can see what's shipped without an account.

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { Route } from './+types/changelog';
import changelogData from '../data/changelog.json';

interface Commit {
  hash: string;
  shortHash: string;
  date: string;
  subject: string;
  body: string;
}

const commits = changelogData as Commit[];

export function meta() {
  return [
    { title: 'Changelog — EduSupervise' },
    {
      name: 'description',
      content:
        "Every release of EduSupervise, in plain English. What changed, when, and why it matters.",
    },
  ];
}

export function loader() {
  // Static import at top-of-file — module-level JSON is parsed once at
  // server boot, then shared across all /changelog requests. Loader
  // returns the cached reference.
  return { commits };
}

// Defensive fallback — if the prebuilt JSON is malformed or missing
// (e.g., a future build/prebuild drift), render a friendly message
// instead of a blank 500 page. Users get a path forward (/support).
export function ErrorBoundary({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <main id="main" className="min-h-screen bg-bg text-primary">
      <article className="mx-auto max-w-3xl px-md py-2xl">
        <Link to="/" className="text-accent text-sm hover:underline">
          ← Back to home
        </Link>
        <h1 className="mt-md text-2xl font-bold">
          Couldn't load the changelog
        </h1>
        <p className="mt-sm text-secondary">
          Something went wrong on our end. Try refreshing the page — and if
          it keeps failing, <Link to="/support" className="text-accent hover:underline">let us know</Link>.
        </p>
        <p className="mt-md text-xs text-secondary">Error: {message}</p>
      </article>
    </main>
  );
}

// Commits tagged with these prefixes are internal-only (test scaffolding,
// CI plumbing, formatting sweeps, etc.) and are dimmed in the timeline.
// User-facing commits get full color and are the only ones the
// "Copy release notes" button includes.
const INTERNAL_PREFIXES = [
  'docs',
  'chore',
  'style',
  'tools:',
  'devops: pdf_calendar_extract', // parser internals
  'db: migration', // schema-only unless the body explains a feature
  'db: schema.ts', // Drizzle mirror of migrations — duplicates
  'db: drop redundant',
  'db: add pg_stat',
  'fix(security): CSP', // CSP tightening is invisible to users
  'fix(ux): /onboarding/solo',
  'fix(health):',
  'fix(entry):',
];

function isInternal(subject: string): boolean {
  return INTERNAL_PREFIXES.some((p) => subject.startsWith(p));
}

function userFacing(commit: Commit): boolean {
  return !isInternal(commit.subject);
}

function groupByDate(commits: Commit[]): Array<{ date: string; commits: Commit[] }> {
  const groups = new Map<string, Commit[]>();
  for (const commit of commits) {
    const key = commit.date || 'Unknown date';
    const list = groups.get(key) ?? [];
    list.push(commit);
    groups.set(key, list);
  }
  return Array.from(groups.entries())
    .map(([date, list]) => ({ date, commits: list }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

function formatReleaseNotes(commits: Commit[]): string {
  const picks = commits.filter(userFacing).slice(0, 10);
  if (picks.length === 0) return '';
  return picks
    .map((c) => {
      // Drop the type prefix (e.g. "admin: " or "fix(security): ") for
      // release notes — they're internal jargon. Keep the rest of the
      // subject as a one-liner.
      const cleaned = c.subject.replace(/^[a-z+()-]+:\s*/, '');
      return `• ${cleaned}`;
    })
    .join('\n');
}

export default function ChangelogPage({ loaderData }: Route.ComponentProps) {
  const { commits } = loaderData;
  const [filter, setFilter] = useState<'all' | 'user'>('all');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [showFallback, setShowFallback] = useState(false);
  const [busy, setBusy] = useState(false);
  const resetTimer = useState<{ current: ReturnType<typeof setTimeout> | null }>({ current: null })[0];

  function armReset(state: 'copied' | 'failed') {
    setCopyState(state);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      setCopyState('idle');
      setShowFallback(false);
      resetTimer.current = null;
    }, 2500);
  }

  const filtered = useMemo(
    () => (filter === 'user' ? commits.filter(userFacing) : commits),
    [commits, filter],
  );

  // Pre-compute the user-facing count once so the filter-tab label
  // doesn't re-scan all commits on every render.
  const userFacingCount = useMemo(
    () => commits.filter(userFacing).length,
    [commits],
  );

  const grouped = useMemo(() => groupByDate(filtered), [filtered]);
  const releaseNotes = useMemo(() => formatReleaseNotes(commits), [commits]);

  async function handleCopy() {
    if (!releaseNotes || busy) return;
    setBusy(true);
    try {
      await navigator.clipboard.writeText(releaseNotes);
      armReset('copied');
    } catch {
      // Fallback: show a textarea modal so the user can manually select +
      // copy. Old "select manually" copy was misleading because there was
      // nothing to select — now there is.
      setShowFallback(true);
      armReset('failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" className="min-h-screen bg-bg text-primary">
      <article className="mx-auto max-w-3xl px-md py-2xl">
        <Link to="/" className="text-accent text-sm hover:underline">
          ← Back to home
        </Link>
        <h1 className="mt-md text-3xl font-bold tracking-tight">
          What's changed in EduSupervise
        </h1>
        <p className="mt-sm text-secondary">
          Every commit, in plain English. The newest stuff is at the top.
          For the App Store "What's New" field, hit the button below to
          copy the last 10 user-facing changes.
        </p>

        <div className="mt-lg flex flex-wrap items-center gap-md">
          <div role="radiogroup" aria-label="Filter" className="inline-flex rounded-md border border-border bg-surface">
            <button
              type="button"
              role="radio"
              aria-checked={filter === 'all'}
              onClick={() => setFilter('all')}
              className={`px-md py-xs text-sm ${filter === 'all' ? 'bg-accent text-on-accent' : 'text-primary'}`}
            >
              All ({commits.length})
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={filter === 'user'}
              onClick={() => setFilter('user')}
              className={`border-l border-border px-md py-xs text-sm ${filter === 'user' ? 'bg-accent text-on-accent' : 'text-primary'}`}
            >
              User-facing ({userFacingCount})
            </button>
          </div>

          <button
            type="button"
            onClick={handleCopy}
            disabled={!releaseNotes || busy}
            data-testid="copy-release-notes"
            aria-describedby="copy-help"
            className="rounded-md bg-accent px-md py-xs text-sm font-medium text-on-accent disabled:opacity-50"
          >
            {copyState === 'copied'
              ? 'Copied to clipboard'
              : copyState === 'failed'
                ? 'Copy again or use the text below'
                : 'Copy latest 10 as release notes'}
          </button>
        </div>

        <p id="copy-help" className="mt-sm text-xs text-secondary">
          <strong>Internal</strong> commits (docs, CI plumbing, style sweeps,
          database schema-only changes) are dimmed and skipped from the
          release-notes copy.
        </p>

        {showFallback ? (
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="copy-fallback-title"
            className="mt-lg rounded-md border border-border bg-surface p-md"
          >
            <h2 id="copy-fallback-title" className="text-base font-semibold">
              Clipboard blocked — copy from here
            </h2>
            <p className="mt-xs text-sm text-secondary">
              Your browser blocked the clipboard write. Select the text
              below and copy with Cmd-C / Ctrl-C:
            </p>
            <textarea
              readOnly
              value={releaseNotes}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Release notes text to copy"
              className="mt-sm w-full rounded-md border border-border bg-bg p-sm font-mono text-sm"
              rows={Math.min(12, releaseNotes.split('\n').length + 1)}
            />
            <div className="mt-sm flex justify-end gap-sm">
              <button
                type="button"
                onClick={() => setShowFallback(false)}
                className="rounded-md border border-border px-md py-xs text-sm"
              >
                Close
              </button>
            </div>
          </div>
        ) : null}

        <div className="mt-2xl space-y-2xl">
          {grouped.map((group) => (
            <section key={group.date}>
              <h2 className="text-lg font-semibold text-secondary">{group.date}</h2>
              <ol className="mt-sm space-y-md border-l border-border pl-lg">
                {group.commits.map((commit) => {
                  const internal = isInternal(commit.subject);
                  return (
                    <li
                      key={commit.hash}
                      className={internal ? 'opacity-60' : undefined}
                    >
                      <h3 className="text-base font-medium">
                        {commit.subject}
                        {internal ? (
                          <span className="ml-sm rounded bg-surface px-xs py-0.5 text-xs text-secondary">
                            internal
                          </span>
                        ) : null}
                      </h3>
                      {commit.body ? (
                        <pre className="mt-xs whitespace-pre-wrap break-words rounded bg-surface p-sm text-sm text-secondary">
                          {commit.body}
                        </pre>
                      ) : null}
                      <p className="mt-xs text-xs text-secondary">
                        <a
                          href={`https://github.com/camster91/edusupervise/commit/${commit.hash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline"
                        >
                          {commit.shortHash}
                        </a>
                      </p>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      </article>
    </main>
  );
}