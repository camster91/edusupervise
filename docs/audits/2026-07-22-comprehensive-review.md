# EduSupervise Comprehensive Review — 2026-07-22

**Scope:** repository-wide source review of web, worker, mobile, shared packages,
CI, data isolation, and documentation.

**Branch reviewed:** `audit/edusupervise-review-fixes`

**Status convention:** `OPEN`, `IN PROGRESS`, `REMEDIATED`, or `VERIFY`.
These are remediation placeholders, not claims that every repository finding
has been closed. Update each row with a PR/commit and verification evidence.

## Executive summary

The architecture has strong foundations: explicit React Router resource routes,
strict TypeScript, Postgres FORCE RLS wrappers, separated workers, and a growing
test suite. The review found one immediate data-contract/security issue in the
new mobile Today endpoint and a reliability issue in date math: web and mobile
had copied the same database loader, the mobile response included broad
school-wide fields, and day windows were advanced with elapsed milliseconds
across DST boundaries.

This review slice centralizes Today data loading, makes calendar arithmetic
DST-safe, preserves the established response contract, and adds contract/date
regressions. Remaining rows below are placeholders for the full review batch.

## P0 — launch or security blockers

| ID | Finding | Evidence / risk | Status | Remediation owner / evidence |
|---|---|---|---|---|
| P0-01 | Mobile Today endpoint exposes a broad school payload | `app.api.today.ts` mirrored the full web loader, including school-wide duties/stats; external-client routes should return least privilege. Contract changes must be coordinated with mobile consumers. | IN PROGRESS | Shared loader removes drift; least-privilege contract follow-up: `TBD` |
| P0-02 | Cross-tenant/system-client paths require explicit review | Any BYPASSRLS query without an unavoidable school predicate can cross tenant boundaries. | OPEN | `TBD` |
| P0-03 | Auth, CSRF, session-cookie and account-recovery audit closure | Verify every mutation and production cookie path against current source, not the 2026-07-04 audit snapshot. | OPEN | `TBD` |

## P1 — correctness and operational risks

| ID | Finding | Evidence / risk | Status | Remediation owner / evidence |
|---|---|---|---|---|
| P1-01 | Today loaders duplicated query and response logic | Web and mobile routes each owned a copy of five DB reads, roster/reminder assembly, and response fields; either could drift silently. | REMEDIATED | `apps/web/server/today.server.ts`; both routes delegate to `loadTodayData` |
| P1-02 | Today date windows used elapsed milliseconds | `now + 86_400_000` and `now + 7 * 86_400_000` do not represent calendar-day increments when DST changes offsets. | REMEDIATED | Calendar-key arithmetic plus spring/fall DST regression tests |
| P1-03 | Week-strip rendering used elapsed milliseconds | Client date cards could repeat/skip around DST depending on host timezone. | REMEDIATED | Calendar keys rendered through UTC date components |
| P1-04 | CI and package verification coverage is uneven | Root CI runs lint/typecheck/unit/build, while integration/E2E and mobile tests have different or placeholder coverage. | VERIFY | Record CI expansion decision and run evidence: `TBD` |
| P1-05 | Migration/bootstrap parity | Existing migrations and fresh-database `db/init` must create equivalent schemas, roles, policies, and cron expectations. | OPEN | `TBD` |
| P1-06 | Production restore and backup evidence | Scripts exist, but current restore drill, retention, and offsite evidence must be attached to this review. | OPEN | `TBD` |

## P2 — maintainability and product quality

| ID | Finding | Evidence / risk | Status | Remediation owner / evidence |
|---|---|---|---|---|
| P2-01 | Repository docs described the pre-monorepo layout and stale versions | Old `AGENTS.md` pointed to root `app/`, `server/`, and `worker/`, and listed outdated package versions/commands. | REMEDIATED | `AGENTS.md` rewritten and dated 2026-07-22 |
| P2-02 | README described local development as planned | The app, worker, mobile workspace, Compose stack, and verification commands now exist. | REMEDIATED | `README.md` refreshed against manifests/source |
| P2-03 | Mobile API types are manually mirrored | `apps/mobile/src/types/api.ts` can still drift from the server contract. Consider generated/shared DTO types without importing server-only modules. | OPEN | `TBD` |
| P2-04 | Today metrics are approximate | `myMinutesPerWeek = myUpcoming * 25` is an estimate rather than duration-derived scheduling data; label or compute explicitly. | OPEN | `TBD` |
| P2-05 | Source comments carry historical audit narratives | Long historical comments obscure current invariants and can become false documentation. Prefer concise rationale plus audit links. | OPEN | `TBD` |

## Remediation verification checklist

- [x] Web and mobile Today transports call one server data loader.
- [x] Date-only math uses calendar keys rather than elapsed milliseconds.
- [x] Spring-forward, fall-back, leap-day, and year rollover regressions exist.
- [x] Mobile resource-route transport contract has focused tests.
- [ ] Mobile endpoint projection is approved as least privilege.
- [ ] Focused web tests pass; paste command/output reference.
- [ ] Web typecheck passes; paste command/output reference or blocker.
- [ ] Web production build passes; paste command/output reference or blocker.
- [ ] Root CI-equivalent checks pass after concurrent branch work settles.
- [ ] P0/P1/P2 rows have owners and linked remediation evidence.

## Files in this remediation slice

- `apps/web/server/today.server.ts`
- `apps/web/server/today.server.test.ts`
- `apps/web/app/routes/_app.today._index.tsx`
- `apps/web/app/routes/_app.today._index.test.tsx`
- `apps/web/app/routes/app.api.today.ts`
- `apps/web/app/routes/app.api.today.test.ts`
- `AGENTS.md`
- `README.md`
- `docs/audits/2026-07-22-comprehensive-review.md`

## Notes for reviewers

The working tree contains concurrent, disjoint review fixes. Do not infer that a
root typecheck/build failure belongs to this slice without checking the failing
path. Preserve unrelated dirty work; verify this slice with focused web tests
first, then web typecheck/build, and report any concurrent blocker verbatim.
