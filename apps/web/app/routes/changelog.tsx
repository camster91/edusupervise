// apps/web/app/routes/changelog.tsx — public changelog / release timeline.
//
// Reads the prebuilt JSON at apps/web/app/data/changelog.json (refreshed
// on every web build via the prebuild hook in package.json). No auth —
// this is a public page so App Store reviewers, prospects, and existing
// users can see what's shipped without an account.

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { Route } from './+types/changelog';

interface Commit {
  hash: string;
  shortHash: string;
  date: string;
  subject: string;
  body: string;
}

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

export async function loader() {
  // Dynamic import keeps the JSON out of the route's static bundle
  // and works at runtime on the server. The prebuild script refreshes
  // this file before every build.
  const data = (await import('../data/changelog.json')).default as Commit[];
  return { commits: data };
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

  const filtered = useMemo(
    () => (filter === 'user' ? commits.filter(userFacing) : commits),
    [commits, filter],
  );

  const grouped = useMemo(() => groupByDate(filtered), [filtered]);
  const releaseNotes = useMemo(() => formatReleaseNotes(commits), [commits]);

  async function handleCopy() {
    if (!releaseNotes) return;
    try {
      await navigator.clipboard.writeText(releaseNotes);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      setCopyState('failed');
      setTimeout(() => setCopyState('idle'), 2500);
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
          <div role="group" aria-label="Filter" className="inline-flex rounded-md border border-border bg-surface">
            <button
              type="button"
              onClick={() => setFilter('all')}
              aria-pressed={filter === 'all'}
              className={`px-md py-xs text-sm ${filter === 'all' ? 'bg-accent text-on-accent' : 'text-primary'}`}
            >
              All ({commits.length})
            </button>
            <button
              type="button"
              onClick={() => setFilter('user')}
              aria-pressed={filter === 'user'}
              className={`border-l border-border px-md py-xs text-sm ${filter === 'user' ? 'bg-accent text-on-accent' : 'text-primary'}`}
            >
              User-facing ({commits.filter(userFacing).length})
            </button>
          </div>

          <button
            type="button"
            onClick={handleCopy}
            disabled={!releaseNotes}
            data-testid="copy-release-notes"
            className="rounded-md bg-accent px-md py-xs text-sm font-medium text-on-accent disabled:opacity-50"
          >
            {copyState === 'copied'
              ? 'Copied to clipboard'
              : copyState === 'failed'
                ? "Couldn't copy — try selecting manually"
                : 'Copy latest 10 as release notes'}
          </button>
        </div>

        <p className="mt-sm text-xs text-secondary">
          <strong>Internal</strong> commits (test scaffolding, CI plumbing,
          style sweeps, schema-only mirror updates) are dimmed and skipped
          from the release-notes copy.
        </p>

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
                      <p className="font-medium">
                        {commit.subject}
                        {internal ? (
                          <span className="ml-sm rounded bg-surface px-xs py-0.5 text-xs text-secondary">
                            internal
                          </span>
                        ) : null}
                      </p>
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