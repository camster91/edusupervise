# EduSupervise full-codebase review — 2026-07-22 (follow-up)

**Branch:** `audit/edusupervise-review-fixes`
**Scope:** repository-wide review of the *current state* of the branch
(including the prior audit-fix batch that landed in the working tree).
**Method:** four parallel review axes (security, devops, performance,
code-quality) plus direct verification of every cited claim. Two
subagent dispatches failed with an upstream HTTP 401 — their findings
were re-derived independently from source.

**Status convention:** `OPEN` (new, not yet addressed in working tree),
`LIKELY-CLOSED` (claimed closed by prior batch but unverified or with
holes), `DOWNGRADED` (closed with documented mitigation), `VERIFIED`
(closed and confirmed).

## Verification gates (all green)

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile` | ✅ |
| `pnpm run lint` | ✅ 0 errors, 111 pre-existing warnings |
| `pnpm run typecheck` | ✅ |
| `pnpm test` | ✅ 13 packages, 105 tests pass |
| `pnpm run build` (packages + web + worker) | ✅ |
| `pnpm audit --audit-level high` | ✅ 0 high/critical, 1 low + 6 moderate |

## Headline findings

The prior batch materially improved the codebase but **left several
P1/P2 gaps open**. This review identifies:

| Severity | Count | New this round |
|---|---|---|
| P0 | 4 | 2 new, 2 carried over as contract drift |
| P1 | 9 | 6 new, 3 carried over |
| P2 | 11 | 9 new, 2 carried over |
| P3 | 4 | 3 new, 1 carried over |
| As-designed (no action) | 3 | pdf cache key, in-memory rate-limit, push stub |

---

## P0 — contract violations and dead code

### P0-1. `packages/schemas/src/auth.ts` is entirely dead code (NEW)
**Files:** `packages/schemas/src/auth.ts:1-228`,
`packages/schemas/src/index.ts:10-11`,
`packages/schemas/package.json:11`,
`apps/web/app/routes/login.tsx`, `reset.tsx`, `forgot.tsx`,
`verify-phone.tsx`, `auth.magic.tsx`, `verify-email.tsx`,
`api.signup.*.ts`.

The whole file (~150 lines: `emailSchema`, `passwordSchema`,
`loginSchema`, `signupSchema`, `forgotSchema`, `resetSchema`,
`magicConsumeSchema`, `magicRequestSchema`, `verifyEmailSchema`,
`verifyPhoneRequestSchema`, `verifyPhoneConfirmSchema`,
`csrfFieldSchema`, plus inferred input types) is **never imported
anywhere in the workspace**. Every route that should consume it
defines its own local Zod schema instead (e.g. `reset.tsx:30`,
`forgot.tsx:45`, `verify-phone.tsx:40`).

`AGENTS.md:55` directs callers to "the shared schemas in
`packages/schemas` where applicable" — but `auth.ts` is the only
schemas file and nothing uses it. The package `exports` map
(`packages/schemas/package.json:11`) even advertises `./auth` and
`./reminder-job` sub-paths, so the export is intentional but the
consumer never landed.

**Fix:** choose one of:
1. Delete `packages/schemas/src/auth.ts`, `index.ts:10-11` references,
   and the `./auth` sub-path export. Update `AGENTS.md` to remove the
   "use shared schemas" instruction.
2. Migrate each route to import the shared schema; this is the
   product-intent path but a larger diff.

### P0-2. `apps/mobile/src/lib/push-core.ts` is dead production code (NEW)
**Files:** `apps/mobile/src/lib/push-core.ts:1-35`,
`apps/mobile/src/lib/push.ts:46-51, 92-99, 249-282`,
`apps/mobile/app/_layout.tsx:38`,
`apps/mobile/src/lib/push.test.ts:2`.

All four exports — `MobilePushData`, `isValidUuidV4`,
`buildPushApiUrl`, `buildDeepLinkFromPush` — are **also redeclared
inline** inside `push.ts:46-51, 92-99, 249-282`. The production
consumer (`_layout.tsx:38`) imports only from `push.ts`.
`push-core.ts` has exactly one importer: `push.test.ts:2`.

`push-core.ts` is a test fixture that has drifted into the source
tree. Worse, `push.test.ts` only exercises the dead copy in
`push-core.ts` — the real production path (`registerForPushNotifications`
at `push.ts:106` and `unregisterForPushNotifications` at `push.ts:209`)
has **zero test coverage** anywhere in the mobile app.
`find apps/mobile -name '*.test.*'` returns only `push.test.ts`.

**Fix:**
1. Delete `apps/mobile/src/lib/push-core.ts`.
2. Move `push.test.ts` to import from `apps/mobile/src/lib/push.ts` and
   add real tests for `registerForPushNotifications` /
   `unregisterForPushNotifications`: PII masking, CSRF-error path,
   permission-denied path, `no_project_id` path, HTTP-error path.

### P0-3. AGENTS.md documents a path that does not exist (NEW)
**Files:** `AGENTS.md:30`, `tests/integration/*` (actual location).

`AGENTS.md:30` says
`apps/web/tests/integration/    DB-backed web integration tests`.
The directory does not exist; integration tests live at
`tests/integration/` (repo root, e.g. `tests/integration/auth-rls.test.ts`,
`tests/integration/billing.test.ts`).

Either the AGENTS layout block is stale or the move was never done.
All other AGENTS.md paths exist. The `pnpm test:integration` command
runs `tests/integration/` at the repo root.

**Fix:** update `AGENTS.md:30` to point at `tests/integration/` (repo
root) and update the layout block to match.

### P0-4. Mobile push test file is a self-test that doesn't cover the production code path (NEW)
**Files:** `apps/mobile/src/lib/push.test.ts:1-27`,
`apps/mobile/src/lib/push.ts:106, 209`.

Covered by P0-2 above. Restated here for prioritization: the highest-
leverage mobile fix is to delete the dead `push-core.ts` and write a
real test that covers `registerForPushNotifications` and
`unregisterForPushNotifications` — the two functions the production
layout actually calls.

---

## P1 — high

### P1-1. `audit_log` is not DB-enforced append-only (NEW)
**Files:** `packages/db/migrations/0000_init.sql:6-17`,
`packages/db/src/client.ts:8-12, 80-89`,
`apps/web/server/audit.server.ts:33-57`.

`audit_log` is a plain table with `id / school_id / user_id / action /
target_type / target_id / metadata / ip_address / user_agent /
created_at`. **No** RLS, no `FORCE RLS`, no `BEFORE UPDATE OR DELETE`
trigger, no `updated_at`. The runtime role `edusupervise_runtime`
(`client.ts:8-12`) does not have `BYPASSRLS`, but nothing at the SQL
layer prevents it from issuing `UPDATE audit_log SET metadata = ...`
if a future code path reaches for it. The only defense today is
convention ("we only ever INSERT via `recordAudit`").

For a compliance-relevant log of `coverage.accept / coverage.decline /
coverage.broadcast / school.rename / school.plan_change`
(`audit.server.ts:81-100`), this is the right severity.

**Fix:** migration `0017_audit_log_immutable.sql` with:
```sql
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE  ROW LEVEL SECURITY;
CREATE POLICY audit_log_no_update ON audit_log FOR UPDATE USING (false);
CREATE POLICY audit_log_no_delete ON audit_log FOR DELETE USING (false);
CREATE POLICY audit_log_insert   ON audit_log FOR INSERT WITH CHECK (true);
CREATE POLICY audit_log_select   ON audit_log FOR SELECT
  USING (current_setting('app.is_system', true) = 'on');
REVOKE UPDATE, DELETE ON audit_log FROM edusupervise_runtime;
```
plus a `BEFORE UPDATE OR DELETE` trigger that raises
`EXCEPTION 'audit_log is append-only'` so the owner role cannot quietly
mutate rows.

### P1-7. `maskToken` is duplicated across the mobile HTTP boundary (NEW)
**Files:** `apps/web/app/routes/api.mobile.push.subscribe.ts:212-215`,
`api.mobile.push.unsubscribe.ts:146-149`,
`packages/push/src/expo.ts:563` (canonical).

Each define their own local `maskToken(token: string)` (identical
4-line body). The canonical version is `packages/push/src/expo.ts:563`
(`export function maskToken`) which is re-exported from
`packages/push/src/index.ts:13`. Three copies, identical logic.

**Fix:** delete both local copies and import from
`packages/push` or `packages/push/src/expo` directly.

### P1-8. Dead `packages/schemas/src/reminder-job.ts#reminderJobPartialSchema` (NEW)
**Files:** `packages/schemas/src/reminder-job.ts:41`,
`apps/worker/src/jobs/reminders.ts:44-46`,
`apps/worker/src/jobs/outbox-flush.ts:36-37`,
`apps/worker/src/index.ts:34-35`.

Exports `reminderJobPartialSchema = reminderJobSchema.partial()` —
the only consumers of this module use `reminderJobSchema` /
`ReminderJobPayload` / `INVALID_PAYLOAD_ERROR` only. Zero importers.

**Fix:** delete the export.

### P1-9. `formatDateInTimeZone` is a public export with no external consumer (NEW)
**Files:** `apps/web/server/today.server.ts:78, 94`,
`apps/web/server/today.server.test.ts:3`.

Exported from `today.server.ts:78`. The only call is internal at
`today.server.ts:94`. The test file (`today.server.test.ts:3`) only
tests `getTodayDateKeys`.

**Fix:** inline it as a module-private function or remove the export.

### P1-2. Stripe v1 verifier: replay window widened to future timestamps (NEW)
**File:** `packages/billing-adapter/src/index.ts:354-356`.

```ts
const tsAgeSec = Math.abs(Date.now() / 1000 - Number(t));
if (!Number.isFinite(tsAgeSec) || tsAgeSec > toleranceSec) return null;
```

Two issues:
1. `Math.abs(...)` accepts future timestamps. An attacker who captures
   a fresh, valid Stripe signature can mutate the header `t` to
   `now + toleranceSec` and the body still HMACs to the same value
   (the HMAC at `:357-359` is over `${t}.${rawBody}`, recomputed
   server-side). The Stripe SDK's `constructEvent` does
   `Math.floor(Date.now()/1000) - tolerance` *without* abs. The
   manual path here diverges from the SDK.
2. `Number(t)` is NaN-guarded but not string-validated.
   `Number('1e1000')` returns `Infinity` (finite); only NaN is caught.
   Add `Number.isInteger(Number(t))` to reject `1e1000`-style inputs.

**Fix:**
```ts
const skew = Date.now() / 1000 - Number(t);
if (!Number.isFinite(skew) || !Number.isInteger(Number(t))) return null;
if (skew < -toleranceSec || skew > toleranceSec) return null;
```

### P1-3. PDF parsers inherit the full `process.env` into Python child (NEW)
**Files:** `apps/web/server/pdf-parser.server.ts:369-379`,
`apps/web/server/pdf_calendar_extract.server.ts:138-142`.

Both call sites use `env: { ...process.env, PDF_PARSE_TIMEOUT_MS: ... }`
(or `PYTHONUNBUFFERED: '1'`). This passes **every environment
variable** to the Python child: `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `SYSTEM_DATABASE_URL`, `DATABASE_URL`,
`REDIS_URL`, `EDUSUPERVISE_SECRETS_DIR`, `APP_URL`, session secrets,
etc. A pdfplumber-based Python script that uses `os.environ` (deliberately
or via `python-dotenv` autoload, or a malicious supply-chain update to
`pdfplumber`) can exfiltrate all of these. The python scripts shipped
today are local and don't read env, but the design assumption is brittle
and the web container's full secret set is the worst-case blast radius.

**Fix:** curated whitelist env object on both call sites:
```ts
env: {
  PATH: process.env.PATH ?? '',
  LANG: process.env.LANG ?? 'C.UTF-8',
  PYTHONUNBUFFERED: '1',
  PDF_PARSE_TIMEOUT_MS: String(timeoutMs),
  // explicit allowlist — never spread process.env
},
```
Drop `PYTHONPATH`, `HOME`, and any `*_SECRET*` / `*_KEY` /
`DATABASE_URL*` from the inherited set.

### P1-4. Fresh-DB bootstrap creates an incompatible reminder channel (NEW)
**Files:** `db/init/02-schema.sql:165-178`,
`packages/db/migrations/0015_mobile_push_subscriptions.sql:11-16,61-64`.

`db/init/02-schema.sql:165-178` creates `reminder_log.channel` as `TEXT`
with a check allowing only `email` and `sms`. Migration 0015 extends
the separate `reminder_channel` enum with `push-expo`. Because the
bootstrap table already exists, later `CREATE TABLE IF NOT EXISTS`
migrations do not convert its `channel` column to the enum. Fresh
databases can finish migrations with a text/check column that still
rejects `push-expo`.

**Fix:** update bootstrap to use the same enum and include `push-expo`,
or stop maintaining a parallel hand-written schema. Add a CI parity
test that provisions an empty Postgres volume, runs init plus
migrations, and compares constraints/types with a migrations-only
database.

### P1-5. Installer and Compose disagree about the owner password (NEW)
**Files:** `docker/docker-compose.yml:9-15`,
`deploy/install.sh:274-300`,
`deploy/edusupervise.env.template:1-8`.

- Compose requires host interpolation for `POSTGRES_PASSWORD`.
- The installer explicitly exports only the secrets directory, runtime
  password, and system password (`deploy/install.sh:290-300`).
- Its comments claim the owner password is supplied through
  `POSTGRES_PASSWORD_FILE` (`deploy/install.sh:274-286`) but the
  Compose service has no corresponding secret/file mount and uses
  `POSTGRES_PASSWORD`.
- The generic template describes separate `*_password.txt` files
  (`deploy/edusupervise.env.template:1-8`) while `install.sh` writes
  runtime/system values into one `.env`.

**Fix:** Choose one contract. Prefer a Compose secret with
`POSTGRES_PASSWORD_FILE`, mount `postgres_password.txt`, and remove
host interpolation. Update the installer and both env templates
together. Add `docker compose config` validation under CI with dummy
secrets.

### P1-6. Backups are locally and remotely world-readable by default (NEW)
**File:** `deploy/backup.sh:57-60, 70-90, 94-98`.

- Local backup directory is created without a restrictive mode.
- `pg_dump` creates the dump under the process umask; a normal `022`
  umask can leave database dumps mode `0644`.
- Offsite rsync explicitly requests `go=r`.

Database dumps contain user/auth/tenant data.

**Fix:** set `umask 077`, create the directory with mode `0700`,
enforce dump mode `0600`, change rsync chmod to `u=rw,go=`. Document
encryption at rest/in transit and periodically test restore integrity.

---

## P2 — medium

### P2-1. CSRF cookie `HttpOnly=false` + `Origin: null` accepted = XSS escalation chain (NEW)
**File:** `apps/web/server/csrf.server.ts:244-255, 435-451`.

The double-submit pattern needs `HttpOnly=false` (acknowledged in
the comment at `:235`). Combined with the `Origin: null` exception
at `:443` (for native apps), an attacker with same-origin XSS can:

1. Read `document.cookie` → grab `__Host-edusupervise.csrf`.
2. `fetch('/api/mobile/push/subscribe', { credentials: 'include', headers: { 'x-csrf-token': cookie }, body: JSON.stringify({ csrf: cookie, expoPushToken: 'attacker-token', platform: 'ios' }) })`.
3. The route at `apps/web/app/routes/api.mobile.push.subscribe.ts:53-64, 76, 106-107` accepts it (no `Sec-Fetch-Site` check, Origin `null` passes).

Result: a victim's device gets its push token silently re-pointed
to the attacker's `ExponentPushToken[...]` — PII leakage through
reminder/coverage notifications.

**Fix:** add a strict CSP nonce to all HTML responses and a
`Sec-Fetch-Site: same-origin` check at `csrf.server.ts:108`. Narrow
`validateCsrfFromJson` to require `Origin` to be present (not just
match) for JSON mutations on web routes; keep the `null` exception
*only* for the mobile `api.mobile.push.*` routes.

### P2-2. `audit.server.ts` swallows insert failures (NEW)
**File:** `apps/web/server/audit.server.ts:49-53`.

```ts
} catch (err) {
  logger.warn(
    { err, action: entry.action, schoolId: entry.schoolId },
    'audit: failed to write audit row (non-fatal)',
  );
}
```

`recordAudit` explicitly swallows errors with the docstring at `:27-32`
claiming "auditable in production via the daily audit-retention job
that flags orphan rows." There is **no** such retention/flagging code
in this repo (verified by grep for `orphan`). A failed audit insert
is logged at `warn` only — never retried, never alerted, never
surfaced to the caller. For a billing-related event
(`school.plan_change`, `coverage.broadcast`) the audit row is the
only tamper-evident record of who did what.

**Fix:** add a failed-audit metric counter
(`audit_insert_failures_total{action}`) and either retry once with
backoff or send a PagerDuty-style alert. The retention cron mentioned
in the docstring needs to exist or the comment needs to be deleted.

### P2-3. Worker healthcheck likely does not test both dependencies correctly (NEW)
**File:** `docker/docker-compose.yml:140-147`.

The worker healthcheck uses `CMD-SHELL` followed by two separate array
entries. `CMD-SHELL` is intended to receive one shell command string.
The Redis probe is not joined with `&&`, so it may become an unused
argument rather than a second executed command. Even if both ran
sequentially, the first Node process exits explicitly without closing
its DB client, and there is no explicit diagnostic distinction.

**Fix:** use one command string joined with `&&`, or add a small
checked-in healthcheck script that probes Postgres and Redis, closes
both clients, and exits nonzero if either fails.

### P2-4. Traefik file router omits security headers and conflicts with Compose routing (NEW)
**Files:** `deploy/traefik/edusupervise.yml:21-28, 30-38, 50-54`,
`docker/docker-compose.yml:101-109`.

- The dynamic HTTPS router has no middleware at all
  (`edusupervise.yml:21-28`).
- Its only middleware is HTTP-to-HTTPS redirect (`edusupervise.yml:30-38, 50-54`).
- Compose attaches only compression to a separate HTTPS router
  (`docker-compose.yml:101-109`).
- Both Compose labels and the dynamic file define routers/services
  for the same host, increasing the chance that requests follow a
  path missing compression or future security middleware.

**Fix:** define and attach one explicit headers middleware containing
HSTS, `X-Content-Type-Options`, frame policy, referrer policy, and
permissions policy. Establish one routing source of truth and test
response headers with `curl -I`. Roll out CSP separately in
report-only mode first.

### P2-5. Coverage broadcast: N×M N+1 (NEW)
**File:** `apps/web/server/coverage.server.ts:372, 374-378, 416-438`.

Two real N+1s in the broadcast path:

1. **`coverage.server.ts:372`** — for each affected duty, the loop
   calls `findEligibleBroadcastCohort({...})` (`:374-378`) — but the
   cohort query depends only on `schoolId` / `excludeTeacherId` /
   `absenceDate`, not on `duty`. For `affected.length = K` duties this
   fires K identical cohort lookups (each one runs 3 SELECTs:
   cycleCalendar, users, dutyAssignments at `:267-307`).
2. **`coverage.server.ts:416-438`** — for each teacher in the cohort,
   individual `await tx.insert(notifications).values(...)`. K duties
   × M cohort members = K·M sequential notification inserts. The
   `coverageAssignments` bulk insert at `:411-414` is good; this is
   the parallel bulk insert that should have been done.

**Fix:**
- Hoist the cohort query out of the outer loop: compute it once
  before `for (const duty of affected)` and reuse. The "cohort empty
  → uncovered row" branch becomes `if (!hoisted)` inside the loop.
- Collect all `notifications` rows across all duties/cohort members
  into one array, then a single `tx.insert(notifications).values(allRows)`
  after the outer loop (same conflict tolerance as
  `parent-alerts.server.ts:253-268`).

### P2-6. Parent-alerts `parent × tag` nested loop (NEW)
**File:** `apps/web/server/parent-alerts.server.ts:151-154`.

```ts
const withTags = parents.map((p) => ({
  ...p,
  routeTags: tags.filter((t) => t.parentId === p.id).map((t) => t.tag),
}));
```

**Nested parent × tag loop**, O(N×M) in-memory scan. The DB query
at `:146-149` is already one SELECT.

**Fix:** build `const tagsByParent = new Map<string, string[]>();`
in one pass over `tags`, then `routeTags: tagsByParent.get(p.id) ?? []`
inside the map — O(N+M).

### P2-10. `void and; void eq;` in `api.mobile.push.subscribe.ts` (NEW)
**File:** `apps/web/app/routes/api.mobile.push.subscribe.ts:46, 221-222`.

`and` and `eq` are imported from `drizzle-orm` (line 46) but the
`.onConflictDoUpdate({ target: [...] })` call (line 163) doesn't need
them. The comment at 217-220 admits they're "unused-import linters
may otherwise strip". Drop the imports and the `void` lines.

### P2-11. `apps/mobile/src/lib/api.ts` over-exports (NEW)
**File:** `apps/mobile/src/lib/api.ts:50, 58, 66, 100, 193`.

`apiFetch` is exported but never called by name from outside the
file. Only `api` (verb wrapper at line 193) and the slice-C helpers
(`isAuthenticated`, `getCookieHeader`, `getCsrfToken`) are imported
externally. `ApiEnvelope` (line 50), `ApiErrorBody` (line 58),
`ApiRequestInit` (line 66), and `apiFetch` (line 100) are only seen by
internal callers.

**Fix:** move `ApiEnvelope` / `ApiErrorBody` / `ApiRequestInit` to a
`types.ts`; keep them exported if the mobile app genuinely imports
them in screen components; otherwise inline as module-private types.

### P2-12. `ApiErrorBody` shape duplicated in `mobile/types/api.ts` (NEW)
**Files:** `apps/mobile/src/lib/api.ts:58`,
`apps/mobile/src/types/api.ts:114`.

Both define `error: string; detail?: string; [key: string]: unknown`.
Different files, same shape.

**Fix:** export from one and import in the other (or both import from
a shared `types/api.ts`).

### P2-13. Test-only handles in `@edusupervise/{billing-adapter,email,sms}` public surface (NEW)
**Files:** `packages/billing-adapter/src/index.ts:462-468`,
`packages/email/src/index.ts:263`,
`packages/sms/src/index.ts:154`.

`currentProvider` and `__testing__` are exported with the explicit
"Test-only exports" comment. They are only consumed by the package's
own test (`index.test.ts:20-21`). Test-only handles should not be in
the public surface; if other packages' tests need them, route through
`@internal` or a separate `./testing` sub-path.

**Fix:** move the test helpers behind a separate export sub-path
(e.g. `./testing`) and exclude from the production `exports` map.

### P2-8. Oversized public surface in `@edusupervise/push` (NEW)
**File:** `packages/push/src/index.ts:7-15`.

The package re-exports `sendBatch`, `buildExpoMessage`,
`classifyMessage`, `classifyFetchError`, `BatchOutcome`,
`ExpoMessageResult` — all of which are only used internally by
`expo.ts` itself. The test file is the only consumer.

**Fix:** mark internal-only exports as non-public (move them out of
`index.ts` or rename to `_internal`). Keep `sendMobilePushToUser`,
`MobilePushPayload`, `MobilePushDispatchResult`, `PushLogger`,
`EXPO_BATCH_LIMIT`, `MAX_ACTIVE_DEVICES_PER_USER`,
`EXPO_REQUEST_TIMEOUT_MS` public (these are the worker-facing
contract).

### P2-9. Unused `BillingProvider` type re-export (NEW)
**Files:** `apps/web/server/billing.server.ts:45, 71`.

The type `BillingProvider` from `@edusupervise/billing-adapter` is
imported and re-exported by `billing.server.ts:71` but never imported
elsewhere in the repo.

**Fix:** remove the unused import + re-export.

---

## P3 — low

### P3-1. Stripe v1 verifier accepts invalid HMAC hex silently (NEW)
**File:** `packages/billing-adapter/src/index.ts:362`.

`Buffer.from(v1, 'hex')` returns a zero-length buffer when `v1` is not
valid hex. The length check at `:362` then returns `null` correctly
— but a non-hex signature that's exactly 32 chars (matching a valid
HMAC length) would produce a different buffer content (only the chars
that parsed as hex) and the `timingSafeEqual` would compare unequal.
No crash, no leak, but the timing of the hex-decode step is not
strictly constant relative to the comparison step. Minor.

### P3-2. CSRF cookie `Max-Age=86400` longer than session cookie (CARRIED, NEW evidence)
**File:** `apps/web/server/csrf.server.ts:251`.

CSRF cookie lives 24h but a logged-out user has no reason to retain
it. Browsers keep it across logouts. Combined with `HttpOnly=false`
(see P2-1), a previously-logged-in victim's CSRF token persists in
`document.cookie` after logout for up to 24h. `logout.tsx` does not
call `mintCsrfCookie` to overwrite.

**Fix:** in `logout.tsx`, set a fresh empty CSRF cookie
(`Max-Age=0`) and explicitly set `__Host-edusupervise.csrf=; Path=/;
Secure; SameSite=Lax; Max-Age=0`.

### P3-3. `pdf_calendar_extract.server.ts` passes `process.env` even though `pdf-parser.server.ts` is the newer precedent (NEW)
**File:** `apps/web/server/pdf_calendar_extract.server.ts:141`.

```ts
env: { ...process.env, PYTHONUNBUFFERED: '1' },
```

Same issue as P1-3 but in the calendar parser. The fix in P1-3 should
be applied to both call sites.

### P3-4. `findReplacement` per-duty (4K queries) (NEW, opportunistic)
**File:** `apps/web/server/coverage.server.ts:442-447`.

For non-broadcast routing, each call to `findReplacement` runs 4
SELECTs (`:202-211` duty, `:213-220` cycle, `:225-233` candidates,
`:237-247` conflicts). For K duties = 4K queries.

**Fix:** lower-priority than P2-5a/b. Acceptable for v1; if K grows,
swap to one batched query that returns all (duty, candidate) pairs in
one shot.

---

## Verified-as-designed (no action needed)

### V-1. PDF parser cache key is `pdf:{jobId}` (random), not sha256
**Files:** `apps/web/server/pdf-parser.server.ts:170-177, 233, 236`.

`jobId` is `randomUUID()` from `node:crypto` (line 57 import) — fresh
per call. `cacheKey` is `pdf:${jobId}`, NOT sha256. Design comment at
`:170-176` documents the intent (re-upload → fresh parse). Re-uploading
the same PDF always re-parses; same user refreshing the review page =
HIT (audit-expected ~80% hit rate). This is working as intended.

### V-2. In-memory rate-limit
**File:** `apps/web/server/rate-limit.server.ts:1-21, 132, 67-91, 139-153`.

Module-local `Map`, no Redis, no DB. State is in-process memory only;
lazy GC sweep at `:139-153`. Comment block `:14-21` documents the
Tier-1 design (single web container, no replica). Tier 2 (Redis) only
when scaling to multiple web replicas.

### V-3. Web Push is a log-only stub
**File:** `apps/web/server/push.server.ts:39-57`.

Single `logger.info({ userId, schoolId, title, tag, dataKeys }, 'push.stub: would have sent...')`.
No `webpush.sendNotification`, no DB I/O, no subscription lookup.
Placeholder for Phase 2 web-push wiring. Future risk: when the real
implementation lands, `VAPID_PRIVATE_KEY` must not be logged anywhere
in `push.server.ts` or `notifications.server.ts:78-90`.

---

## Carried over from prior batch (status update)

| ID | Prior status | Current status |
|---|---|---|
| Billing fail-closed | Closed | **VERIFIED** — `packages/billing-adapter/src/index.ts:85-107` (`resolveProvider`) fails closed; mock requires `ALLOW_MOCK_BILLING=1` / `ALLOW_MOCK_WEBHOOK=1` |
| Session `__Host-` migration | Closed in 1 of 8 routes | **VERIFIED** — all 8 routes migrated to `setSessionCookie(token)` / `clearSessionCookie()`; reviewer-flagged B1 fully closed |
| CSRF null-Origin note | Documented mitigation | **DOWNGRADED** — see P2-1 (real XSS escalation chain remains) |
| Outbox deterministic jobId | Closed | **VERIFIED** — but see P2-5 (notifications insert is its own N+1) |
| Scheduler tenant/timezone | Closed | **VERIFIED** — but see P1-4 (fresh-DB bootstrap drift on reminder_log.channel) |

---

## Recommended remediation order (single batch)

1. **P0-2 + P0-4** (delete `apps/mobile/src/lib/push-core.ts`, rewrite
   `push.test.ts` to cover real `registerForPushNotifications` /
   `unregisterForPushNotifications`) — fixes the most exposed
   un-tested production path in this branch.
2. **P0-3** AGENTS.md path drift — 1-line fix.
3. **P1-3** (PDF env leak) — 1-line call-site change, do both files in
   one commit.
4. **P1-2** (Stripe verifier) — 1-line verifier change + new test.
5. **P2-5** (coverage N+1) — hoists + bulk insert; medium refactor with
   full test.
6. **P1-1** (audit_log RLS) — migration only, no app code change.
7. **P0-1 + P1-8 + P1-7 + P1-9 + P2-8 + P2-9 + P2-10 + P2-11 + P2-12 +
   P2-13** (dead code + duplicates + oversized surface) — pure
   deletions + 1 import consolidation, ~50 lines net.
8. **P1-4 + P1-5 + P1-6 + P2-3 + P2-4** (deploy/devops) — bundle into
   one deploy hardening PR.
9. **P3-2** (CSRF cookie TTL on logout) — 1 route change.

Skip in this batch:
- **P2-1** (XSS escalation chain) — needs a CSP refactor across the
  entire web app; defer.
- **P3-1, P3-3, P3-4** — opportunistic.

## Honest caveats

- The code-quality subagent dispatched first hit a transient upstream
  HTTP 401 from the subagent backend, then retried successfully and
  landed the full report (P0 #1–#4 + P1 #5–#9 + P2 #10–#13). It found
  the AGENTS.md path drift and the dead `push-core.ts` self-test
  pattern that I missed on the first aggregation. Those are now folded
  in as P0-1 through P0-4 and additional P1-7/8/9 and P2-10/11/12/13.
- The security, devops, and performance axes landed full reports on
  first dispatch.
- `apps/worker/scripts/run-worker-tests.ts` integration script still
  requires live Postgres (`ECONNREFUSED` in this sandbox); unchanged
  from prior audit.
- `main` is 40 commits behind `origin/main`; not closed.
- **No commits created** — per the rule that `git commit` is a
  discrete checkpoint awaiting your "go".

## Where the work lives

- Branch: `audit/edusupervise-review-fixes`
- Working tree: dirty with all prior fixes plus this review doc
- Status: ready for your review
- **No commits, no push** — held until you say so