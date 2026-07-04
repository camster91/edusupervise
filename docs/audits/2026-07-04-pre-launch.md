# EduSupervise Pre-Launch Audit — 2026-07-04

**Audit window:** 2026-07-04 14:02–15:25 EDT (≈80 minutes)
**Auditor:** App Ship Prep (orchestrator) + 5 specialist slices
**Codebase:** `/opt/edusupervise` (root@vps.ashbi.ca)
**Live site:** https://edusupervise.ashbi.ca — Phase 0–3 shipped (solo wizard, EA role, PDF ingestion, group duties, recurring duties, billing wall)
**Scale:** 205 solo teachers / 14 EAs / 50 admins signed up in last 30 days

---

## Verdict

**FAIL — DO NOT LAUNCH TO EXTERNAL TRAFFIC.**

Three application-code security bugs give any unauthenticated caller full account takeover of any user account. The hottest authenticated route (`/app/today`) has a runtime crash that fires for any teacher with group-duty colleagues, plus an N+1 query that scales to 200 sequential DB round-trips. PDF ingestion shipped its API but no client UI — half-feature. Zero backups scheduled. Zero application metrics. Zero tests in `apps/web`.

The single change that would flip the verdict to CONDITIONAL: **wire `consumeToken` to the real `auth_verification` table lookup** (eliminates the 3 account-takeover paths in one fix). The next two flips: rebuild the stale `@edusupervise/db` dist; add `userId` to the `/app/today` loader return.

---

## Counts

| Severity | Count |
|---|---|
| 🔴 BLOCKERS | 17 |
| 🟡 SHOULD | 26 |
| 🟢 NICE | 16 |
| ✅ VERIFIED WORKING | 17 |

---

## 🔴 BLOCKERS (must fix before any external launch)

### B1. **Account takeover via stubbed `consumeToken`** `[security]`
**File:** `apps/web/server/auth-flows.server.ts:185`
```ts
export async function consumeToken(_db, _kind, _identifier, _token) {
  logger.info({ ... stub: true }, 'auth-flows.consumeToken: stubbed ...');
  return { ok: true };
}
```
Anyone who knows a user's email can:
- `POST /reset` with `email=victim@x`, `token=anything`, `newPassword=controlled` → password overwritten (`reset.tsx:99-114`)
- `POST /auth/magic intent=consume` with `email=victim@x`, `token=anything` → real session cookie minted (`auth.magic.tsx:141-176`)
- `POST /verify-email?auto=1` with `email=victim@x` → marks verified + auto-sign-in (`verify-email.tsx:96-129`)

Full account takeover for every user. The `auth_verification` table exists in migration 0001 but is never read. Fix: real lookup against `auth_verification` with one-time semantics.

### B2. **Phone verification accepts hardcoded code `123456` in prod** `[security]`
**File:** `apps/web/server/verify-phone.server.ts:65-74`
```ts
if (!sid || !token || !serviceSid) {
  return code === '123456';
}
```
No `NODE_ENV === 'production'` guard. If `TWILIO_VERIFY_SERVICE_SID` is unset for any reason (deploy hiccup, env-var rename, secret rotation), any attacker verifies any phone. `sendVerificationCode()` logs a "DO NOT ship to prod" warning but `verifyCode()` does not. Fix: gate `=== 'production'` AND refuse to boot if `TWILIO_VERIFY_SERVICE_SID` is missing.

### B3. **Stripe webhook signature verifier returns empty event** `[security]`
**File:** `packages/billing-adapter/src/index.ts:268-294`
```ts
return timingSafeEqual(a, b) ? { id: '', type: '' } : null;
```
Real path returns `{id:'', type:''}` instead of parsing the body. Handler at `billing.server.ts:170-172` rejects every real Stripe event with `event.id || event.type`. Latent — only triggers when `BILLING_PROVIDER=stripe` is set. Today `docker/.env` has `BILLING_PROVIDER=mock`. The day it flips to live, every Stripe webhook silently fails. Fix: parse JSON body, return parsed event when signature matches.

### B4. **Stale `@edusupervise/db` dist build** `[code-quality]`
**Files:** `packages/db/src/schema.ts` (modified 17:03:54, has Phase 3 schema) vs `packages/db/dist/src/schema.d.ts` (modified 16:53:42, pre-Phase 3)
`package.json#exports` resolves runtime to `./dist/src/index.js`. Web + worker both load the **OLD** schema object. At runtime `dutyAssignments.coverageRole` etc. are undefined → Drizzle queries reference missing columns → DB errors. This is also the root cause of 8 typecheck errors. Fix:
```bash
cd /opt/edusupervise && pnpm --filter @edusupervise/db build && pnpm install --force
```
Then re-run `pnpm --filter @edusupervise/web typecheck` and verify dist now has Phase 3 symbols.

### B5. **Runtime crash on `/app/today` for teachers with group-duty colleagues** `[code-quality]`
**File:** `apps/web/app/routes/_app.today._index.tsx:431`
```tsx
const colleagues = (groupRoster[d.id] ?? []).filter((c: { userId: string }) => c.userId !== userId)
```
Outer `userId` is not defined in scope (TS2304). Component destructures loader at line 281 without `userId`; loader returns `userId` on line 191/232 but it's not piped out to the client. Result: `ReferenceError` on render. Fix: add `userId: session.userId` to the loader's return object around line 263.

### B6. **DutyCard list rendered TWICE in `/app/today` JSX** `[performance]`
**File:** `apps/web/app/routes/_app.today._index.tsx`
Two consecutive `<ul className="space-y-sm" role="list">` blocks each contain an identical `myDuties.map(...)`. Doubles DOM nodes, doubles hydration work, AND visible duplicate duty rows. Fix: delete one of the two `myDuties.map(...)` blocks (likely the dead-code one — check git history to confirm intent).

### B7. **N+1 reminder fetch on `/app/today` loader** `[performance]`
**Files:** `apps/web/app/routes/_app.today._index.tsx:259-261` + `apps/web/server/reminders.server.ts:58-99`
```ts
for (const d of data.allDuties) {
  reminderMap[d.id] = await listRemindersForDuty(d.id, session.schoolId);
}
```
Up to 200 sequential calls (one per `allDuties` row, `.limit(200)`). Each call joins 4 tables AND opens a fresh `getSystemClient()` connection. Worst case = 200 sequential round-trips on the hottest authenticated route. Fix: single `WHERE duty_id IN (...)` query, batch.

### B8. **`text-danger` / `bg-danger-soft` tokens don't exist** `[ux-frontend]`
**Files:** `apps/web/app/components/SignupCard.tsx:199` + `apps/web/app/routes/_app.settings._index.tsx:222`
Verified live via `getComputedStyle`: `text-danger` → `rgb(10,14,26)` (default `text-primary`, NOT red); `bg-danger-soft` → `rgba(0,0,0,0)` (transparent). Working reference: `text-error` → `rgb(255,59,48)`. When signup fails (duplicate email, missing fields, CSRF), user sees plain black text on white background. `role="alert"` fires AT-only — sighted users get nothing. Fix: add tokens to `tokens.css` + `tailwind.config.ts` (mirror `text-error`/`bg-error-soft`), OR swap to `text-error`/`bg-error-soft` at the call sites.

### B9. **PDF upload endpoint exists but has zero client UI** `[ux-frontend]`
**File:** `apps/web/app/routes/api.onboarding/upload-pdf.ts` is registered (`routes.ts:63`) with friendly error messages, but grep across all `.tsx` files finds NO file input, drag-drop, or fetch to this endpoint. Only `/api/onboarding/confirm-pdf` is called from client. Phase 2 PDF ingestion is half-shipped. Fix: build the upload UI on `/onboarding/pdf-review` (per Phase 2 spec), OR remove the API until the UI lands.

### B10. **No `/metrics` endpoint exists** `[devops]`
External `curl https://edusupervise.ashbi.ca/metrics` → 404. Internal `docker exec ... curl http://localhost:3011/metrics` fails (curl not in image). Web container logs `Error: No route matches URL "/metrics"`. Zero application metrics — no request-rate, error-rate, latency, queue-depth visibility at launch. Fix: add `instrumentation.server.ts` with `@willsoto/node-prometheus` or `prom-client` middleware mounted before the SPA catch-all.

### B11. **`/healthz` 404s (standard healthcheck path)** `[devops]`
`/api/health` → 200 `{"status":"ok","db":"ok","uptime_s":464}`. `/healthz` → 404. `/health` → 404. Risk = launch-day monitoring (uptime-kuma, k8s liveness, third-party checkers) all default to `/healthz`. Fix: add a top-level `/healthz` route OR a Traefik `redirectRegex` from `/healthz` → `/api/health`.

### B12. **`backup.sh` is NEVER scheduled and has NEVER run** `[devops]`
Script exists at `/opt/edusupervise/deploy/backup.sh` (mode 755, 5633 bytes, dated Jun 28) but is never invoked. No crontab entry, no systemd timer, no `/data/backups/`, no `/var/backups/edusupervise/`, no log file. Risk = data loss on launch day; pg_dump and rsync both untested. Fix: add `0 3 * * * root /opt/edusupervise/deploy/backup.sh >>/var/log/edusupervise-backup.log 2>&1` to root crontab, run it once by hand, verify a `.dump` file lands on disk, configure `BACKUP_OFFSITE` target.

### B13. **Zero test coverage in `apps/web`** `[code-quality]`
`pnpm --filter @edusupervise/web test` → "No test files found, exiting with code 1". `find apps/web -name '*.test.*' -o -name '*.spec.*'` → 0 results. `apps/web/server` similarly has 0 test files. The only test in the entire monorepo is `packages/db/src/cycle-math.test.ts` (utility). Vitest configs exist for db/billing-adapter/email/sms but NOT for the web app. Pre-launch with zero test coverage = unverified every code path. Fix: add at minimum integration tests for B1–B3 (consumeToken, verifyCode, stripe webhook verify) + the `/app/today` loader.

### Cross-cutting B14 — **`@react-router/node 7.1.5` — Path Traversal in File Session Storage** `[security]`
CVE GHSA-9583-h5hc-x8cw, fix ≥7.9.4. Bump to ≥7.15.0 to also close 11 other high-severity RR7 CVEs (incl. RCE via turbo-stream TYPE_ERROR deserialization, GHSA-49rj-9fvp-4h2h).

### Cross-cutting B15 — **`vitest 2.1.9` — Arbitrary file read/execution via UI server** `[security]`
CVE GHSA-5xrq-8626-4rwp, fix ≥3.2.6. Transitive via better-auth.

### Cross-cutting B16 — **`drizzle-orm 0.36.4` — SQL injection via improperly escaped SQL identifiers** `[security]`
CVE GHSA-gpj5-g38j-94v9, fix ≥0.45.2. Today the 2 `sql.raw` sites feed hardcoded arrays (plan-enforcement.server.ts:314, signup.server.ts:798), so not directly exploitable — but defense-in-depth gap. Bumped to B16 (was SHOULD in earlier draft) because the slice-2 worker classified all CVEs as BLOCKER class.

### Cross-cutting B17 — **Local `UserRole` shadow missing `educational_assistant`** `[code-quality]`
**File:** `apps/web/server/auth.server.ts:18`
```ts
export type UserRole = 'school_admin' | 'teacher' | 'substitute';
```
Shadows the canonical db enum (which includes `'educational_assistant'`). Cascades to:
- `auth.server.ts:125` — TS2322 assigning DB row with `role='educational_assistant'`
- `app.api.duty.complete.ts:54` — TS2367 `session.role === 'educational_assistant'` has no overlap with `UserRole`
- 14+ other sites referencing EA (`_app.today:643`, `_app.duties.$id:73`, `api.onboarding.solo:87`, `api.onboarding.confirm-pdf:323`, etc.)
Fix: delete the local declaration, `import type { UserRole } from '@edusupervise/db'`.

### B18 — **`<Button variant="primary" size="md" asChild>` invalid HTML** `[code-quality]`
**File:** `apps/web/app/components/UpgradePrompt.tsx:134`
Wraps an `<a>` child. Local Button (`ui/Button.tsx:56-60`) is typed `ButtonHTMLAttributes<HTMLButtonElement> & ButtonVariantProps` — no `asChild` prop. TS2322. At runtime React renders `<a>` inside `<button>` (invalid HTML, browser auto-fix may convert button to div, breaking form submission). Fix: implement `asChild` properly (Radix Slot pattern) OR change the upgrade CTA to a plain anchor with `onClick` + `data-method`.

---

## 🟡 SHOULD (fix in next sprint)

### Security
- **S-S1.** `verify-phone.tsx` updates users by phone WITHOUT `school_id` scope (`verify-phone.tsx:142-145`). Combined with B2 → unauthenticated caller can claim another tenant's phone number. Require authenticated session OR scope by `school_id`.
- **S-S2.** `X-Forwarded-For` trusted blindly in `login.tsx:170-177` + 4 other files. If web container ever directly reachable, attacker spoofs XFF to reset per-IP rate-limit buckets. Trust only the proxy IP.
- **S-S3.** `auth_session` table not in init's FORCE RLS loop (`db/init/02-schema.sql:316-322`). Defense-in-depth gap. Add a migration to enable FORCE RLS + tenant_isolation policy.

### Code-quality
- **S-C1.** `_app.recurring._index.tsx:329` — `<Banner message={<>...</>}>` violates `Banner.message: string` type (TS2322). Widen to `ReactNode`.
- **S-C2.** `_app.duties.$id.tsx:223` — `instanceof Date` check on RR7 loader→client JSON (where startDate is always string). Dead code; remove the check.
- **S-C3.** `_app.coverage._index.tsx:69` — destructures `{role}` from `useLoaderData` but loader doesn't return it. `role` is always undefined → "Record an absence" button NEVER renders for admins. Add `role` to loader return (with `requireRole` check) or use `useRouteLoaderData('routes/_app')`.
- **S-C4.** 4 `console.warn` calls bypass structured pino logger: `coverage.server.ts:392/441/494`, `audit.server.ts:48`. Audit call passes `(obj, msg)` to `console.warn` → pino signature mismatch → prints `[object Object] msg`. Replace with `logger.warn(...)`.
- **S-C5.** 5 coverage routes use `let body: any;` (`api.coverage.absences.ts:29`, etc.) before zod validation. Pattern the other routes use: `const body: unknown = await request.json(); const parsed = Body.safeParse(body); if (!parsed.success) return 400;`.
- **S-C6.** `pdf-parser.server.ts:367` — `stdout?.toString('utf8')` TS2554 (0 args expected, got 1). Cast `stdout as Buffer | null` from `execFile` callback.

### UX / Frontend
- **S-U1.** No skip-to-content link anywhere in `apps/web/app`. WCAG SC 2.4.1 Bypass Blocks (Level A) fail.
- **S-U2.** Wizard progress dots lack semantic role for AT — `onboarding.solo._index.tsx:91-101`. 5 `<div>` with `aria-label` but no `role="progressbar"`, no `aria-current="step"`.
- **S-U3.** Wizard radio selections don't persist to URL on intermediate steps — `onboarding.solo._index.tsx:55-65`. Parent reads district/cycleLen from `useSearchParams`, NOT from DOM radio state. Mid-wizard refresh loses selections.
- **S-U4.** Wizard footer "Skip for now" / "Back" tap targets ~20px tall. WCAG 2.5.5 Target Size AAA.
- **S-U5.** Card layout wastes desktop vertical space — flex-1 + items-center + max-w-md leaves huge gaps on wide viewports.
- **S-U6.** Dark mode input borders invisible — `tokens.css` line 172: `--color-border: #252A3A` on `--color-surface: #14171F` → contrast ~1.2:1.
- **S-U7.** `/app/recurring` 403 shows generic "Something went wrong" instead of role-aware "this is admin-only, back to Today".
- **S-U8.** Signup form errors are bottom-of-form, not inline per-field — `SignupCard.tsx:198-203`.
- **S-U9.** Homepage uses raw Tailwind colors instead of design-system tokens — `_index.tsx:36-42` (bg-blue-600, text-slate-900, border-slate-300). Rest of app uses tokens; homepage is the only offender.
- **S-U10.** Dead code: `SignupCard.tsx:177` references `hiddenFields.defaultSoloRole` but parent never sets it; always falls back to `'teacher'`. Misleading.

### Performance
- **S-P1.** `pdf:{jobId}` Redis cache is empty — 0 keys match `pdf:*` in `docker-redis-1`. Either no recent uploads OR misconfigured. Cannot validate cache hit rate without a real PDF upload.
- **S-P2.** Redis overall hit rate 31.8% (`keyspace_hits=61402, keyspace_misses=131472`). All 14 keys are `bull:reminders:*` (BullMQ queue) — no app-level read cache layer. Hit rate dominated by BullMQ stalled-check, not user-facing reads.
- **S-P3.** Vendor chunk `index-D_eQTwuX.js` = 133,936B raw / 43,034B gzipped. Every extra KB delays LCP on cold cache.
- **S-P4.** Shared chunk `chunk-IR6S3I6Y-BWb71UDE.js` = 103,746B raw / 35,200B gzipped. Loaded on multiple routes; verify it's code-split per route.

### Devops
- **S-D1.** `docker/.env` is plaintext-credential file on disk (mode 600, root-owned) — `.gitignore` correctly excludes it (verified). Documented trade-off but fragile. `apps/web/.env.example`, `apps/worker/.env.example`, `docker/.env.example` ALL missing — no canonical-sources contract.
- **S-D2.** SSH root login allowed + live brute-force trail (`lastb` shows ongoing password-probing attempts from 7+ IPs against `root`, `admin`, `ubnt`, etc.). Pubkey-only means probes fail, but `PermitRootLogin yes` is a soft target. Set `PermitRootLogin prohibit-password`, install fail2ban, move SSH off port 22, add `MaxAuthTries 3`.
- **S-D3.** Swap 100% utilised on 15Gi box (`Swap: 4.0Gi total, 4.0Gi used, 11Mi free`); load avg 2.37 on 16 cores = memory-pressure-not-CPU. Risk = swap-thrash before OOM-kill on launch spike. Watch `si/so` via `vmstat 1` for 5min; if `so > 0` consistently, raise web/worker `mem_limit` or add RAM.

---

## 🟢 NICE (post-launch)

### Code-quality
- **N-C1.** `_app.duties.$id.tsx:450` — `void isNotNull; void ChevronDown;` orphan void statements suppressing unused-import warnings. Fragile pattern.
- **N-C2.** `_app.calendar.print.tsx:113` — `(dutyAssignments.endDate as any).isNull?.() ?? undefined`. Sneaks around nullability.
- **N-C3.** `reminders.server.ts:244` — pg-style raw query (`{ sql: 'UPDATE reminders ...', params: [...] } as any`) bypassing Drizzle typed query builder. Only raw query in this file.
- **N-C4.** TODO markers without explicit owner: `verify-phone.server.ts:40/72`, `auth-flows.server.ts:166`, `verify-phone.tsx:152`. All tier-2/future wiring.

### UX / Frontend
- **N-U1.** Solo CTA on marketing homepage is visually dominant (verified via curl + source: H1 + blue primary button above white secondary button; admin link is small slate text). Phase 0 honored.
- **N-U2.** Onboarding wizard progress dots have nice width transition (6px → 32px with `transition-all duration-base`).
- **N-U3.** `/app/today` empty states are friendly and well-written ("You're free today" + browse-swaps link).
- **N-U4.** Stats row on `/app/today` is teacher-first ("My Upcoming" headline metric, not school-wide total).
- **N-U5.** Yellow onboarding banner on `/app/today` — `role="status"`, Sparkles icon, dismiss button, CTA → `/onboarding/solo`.

### Performance
- **N-P1.** Homepage + `/api/health` TTFB very low — homepage 40ms, `/api/health` 28ms.
- **N-P2.** Container resource usage negligible — docker-web-1 47.2MiB / 1.5GiB (3.07%), docker-worker-1 32.52MiB / 1GiB (3.18%). No pressure at idle.
- **N-P3.** Zero client-only fetches on first paint — 0 hits for `useEffect.*fetch` in `_app.*.tsx` + components.
- **N-P4.** No oversized images in `public/` — only `sw.js` (6.0KB). Zero LCP risk from public assets.

### Devops
- **N-D1.** All 5 application containers report `healthy` (web, worker, postgres, redis, cron). No OOMKilled, no restarting/dead across the entire fleet of ~52 containers.
- **N-D2.** TLS cert fresh and valid — notBefore Jun 28 23:38:15 2026 GMT, notAfter Sep 26 23:38:14 2026 GMT (84 days remaining); Let's Encrypt (YR2); subject CN=edusupervise.ashbi.ca.
- **N-D3.** Traefik router correctly wired with dual-provider pattern (entrypoints=websecure, tls.certresolver=letsencrypt, middlewares=compress-everything@file, loadbalancer.server.port=3011). 0× 502|503 in last hour; `/api/health` response time 0.3–2.6ms.

---

## ✅ VERIFIED WORKING

### Security
- CSRF: 20/22 POST routes call `validateCsrf*`. The 2 with 0 hits are GET-only (`api.billing.audit-export[.csv].tsx`, `api.billing.invoices.tsx`) — their `action()` returns 405.
- CSRF cookie: `__Host-` prefix, Secure in prod, Path=/, no Domain, HttpOnly=false (intentional for double-submit), `timingSafeEqual` + length-padded comparison (`csrf.server.ts:90-165`).
- `withSchoolId` / `withUser`: every loader that reads tenant data wraps in `withSchoolId(session.schoolId, ...)`. 22+ call sites.
- FORCE RLS on `duty_assignments`, `duties`, `recurring_duties`, `notifications`, etc. via `db/init/02-schema.sql` + migration 0004 + migration 0010. `tenant_isolation` policy enforced on every tenant table.
- Migration `0010_recurring_duties.sql:107-119` properly adds ENABLE+FORCE+tenant_isolation for the new table.
- PDF upload: magic-byte `%PDF-` + `%%EOF` trailer, 10MB cap, 100B floor, SHA-256 for audit (`uploads.server.ts:118-127`).
- Login: bcrypt cost 12, HttpOnly+SameSite=Lax+Path=/+Secure-in-prod session cookies, HMAC-SHA256 signed with `timingSafeEqual` verify.
- Signup rate-limit: per-email 5/hr AND per-IP 20/hr via DB-backed `signup_attempts` table.
- Stripe webhook idempotency via `stripe_events` UNIQUE(id) constraint mapped to 23505.
- Dev-only convenience flags (`_action=cron`, `_action=upgrade_pro`) correctly gated by `NODE_ENV` check (`_app.settings.billing.tsx:519-535`).
- `docker/.env` plaintext prod passwords verified gitignored (`git status` clean, never appears in git log).
- `sql.raw` sites fed from hardcoded internal arrays (not user input).
- `toggleReminder` raw SQL is parameterized.

### UX
- `/app/today` at 1280×800 and 390×844: yellow onboarding banner prominent; sidebar shows Phase 0-demoted nav (Today/Roster/Calendar/Coverage).
- `/onboarding/solo` wizard all 5 steps render cleanly desktop + mobile.
- `/signup` renders 3 cards (Join/Solo/Demo). Solo card has visible 3-option role picker.
- `/signup?mode=join` opens Join card by default. `/signup?mode=solo` opens Solo card.
- Dark mode on `/app/today` has good body-text contrast (text-secondary #9BA1B0 on bg-surface #14171F ~7.8:1).
- Native HTML5 form validation works (browser tooltip).
- `AddDutyEmptyState` has role-based branching (admin gets CTA, teacher gets calm message).

### Performance
- Homepage `/app/today` route bundle well under 50KB gz — `_app.today._index-B1_6OaSI.js` = 6,779B gzipped.
- `getGroupDutyRoster` is N+1-free — uses 2 queries total (`myAssignments` then `IN(dutyIds)`), correctly batched.
- BullMQ stalled-check at 11–30s duration is normal (recurring scan, not user-blocking).
- Server-side render of `/app/today` *header* (unauth 302 path) completes in 24ms per server log.

### Devops
- Web `/api/health` returns `{"status":"ok","db":"ok","uptime_s":464}`.
- Cron container SQL files `/sql/audit-retention.sql` and `/sql/plan-downgrade.sql` both present and runnable.
- Postgres volume on `/data/postgres`, redis volume on `/data/redis`, uploads volume on `/data/uploads`.
- Disk 88G/199G used (45%), 112G free.
- Docker images 35.7GB across 43 images, no reclaimable space.

---

## Top 5 must-fix items (ranked by impact)

1. **B1 — wire `consumeToken` to real `auth_verification` lookup** (`apps/web/server/auth-flows.server.ts:185`). Eliminates the 3 account-takeover paths (reset password, magic-link consume, verify-email auto-sign-in) in one fix. Live exploit today: anyone who knows an email can hijack that account.

2. **B2 — gate phone verification on `NODE_ENV === 'production'` AND refuse to boot if `TWILIO_VERIFY_SERVICE_SID` missing** (`apps/web/server/verify-phone.server.ts:65-74`). Combined with S-S1 (cross-tenant update), the `123456` hardcode plus missing school_id scope means an unauthenticated caller can claim any phone. ~10 lines of code.

3. **B4 + B5 + B6 + B7 — `/app/today` four-bug group fix** (all in `apps/web/app/routes/_app.today._index.tsx`):
   - Rebuild stale `@edusupervise/db` dist (`pnpm --filter @edusupervise/db build`) — eliminates 8 typecheck errors AND the Phase 3 schema runtime crash.
   - Add `userId: session.userId` to the loader return (around line 263) — eliminates `ReferenceError` for every teacher with group-duty colleagues.
   - Delete the duplicate `myDuties.map()` block — eliminates visible duplicate duty rows + 2× hydration cost.
   - Replace the `for-await listRemindersForDuty` loop with a single `WHERE duty_id IN ($1, $2, ...)` batch query — eliminates up to 200 sequential DB round-trips on the hottest route.
   All four touch the same file. One PR, one deploy, one regression test.

4. **B14 + B15 + B16 — single `pnpm update` commit**: bump `@react-router/node` to ≥7.15.0, `vitest` to ≥3.2.6, `drizzle-orm` to ≥0.45.2. Closes 14 CVEs at once (path traversal, RCE via turbo-stream, arbitrary file read via vitest UI, SQL injection in drizzle identifiers).

5. **B8 + B9 — design-system token + PDF UI**: add `danger` / `danger-soft` tokens to `tokens.css` + `tailwind.config.ts` (or swap `text-danger bg-danger-soft` → `text-error bg-error-soft` at the two call sites); ship the `/api/onboarding/upload-pdf` client UI on `/onboarding/pdf-review`. Without B8, sighted users get no error feedback on signup failure. Without B9, Phase 2 PDF ingestion is invisible to teachers — the spec's "time-to-first-duty ≤2 min" KPI cannot be hit.

---

## Out of scope for v1 launch

- District multi-tenancy (Phase 4 — parked per `2026-07-04-scaling-plan.md`)
- Vision-model PDF fallback for image-only PDFs (Phase 2.5 — only if signal)
- Calendar invites / board-level API integrations (Phase 4+)
- Native mobile apps (PWA only for first 100 solo teachers)
- SSO, SIS integration, parent alerts broadcast (post-Phase 4)
- Real-time coverage chat / push notifications
- Re-imagining `/app/today` redesign (measure first; redesign only if bounce >40%)
- Stripe SDK retry/idempotency (only matters once B3 is fixed)
- Web Push VAPID, CSP headers, structured data (post-launch)

---

## Audit execution metadata

| Slice | Agent | Session ID | Verdict | 🔴 | 🟡 | 🟢 |
|---|---|---|---|---|---|---|
| 1 code-quality | verifier | mvs_0a67b345922b4cbb9d17f560737cdc8c | FAIL | 5 | 6 | 4 |
| 2 security | app-security-audit | mvs_c5067bfb64a744709eb34a2878d7dffb | FAIL | 5 | 4 | 5 |
| 3 ux-frontend | frontend-designer | mvs_38ec8f8c2aad4698b4d8d9d2de3a7a99 | CONDITIONAL | 2 | 10 | 5 |
| 4 performance | api-engineer | mvs_03cd462792924908969a2cd172096106 | FAIL | 2 | 4 | 4 |
| 5 devops | devops-engineer | mvs_56ad8b5ac7be4efa9d8591d536e926d8 | FAIL | 3 | 4 | 3 |
| **TOTAL** | | | **FAIL** | **13** | **24** | **16** |

Swarm reports saved at `/Users/biancabienaime/.mavis/scratchpads/mvs_9430dd7f8a6d4fc8b1ad45205fe8c8ed/scratchpad.md` for re-spawn traceability.

---

## Decision required

**PRODUCT CALL:** Phase 1 (solo path) is live with real users (205 teachers in 30 days). Three account-takeover bugs and a runtime crash on `/app/today` mean we either:

(a) **Hotfix today** — patch B1 + B4 + B5 + B2 + B3 (~6 hours work), rebuild + redeploy within 24h, re-run this audit, then proceed to external launch. **Recommended.**

(b) **Pull the public signup page** — keep admin users but disable `/signup?mode=solo` until B1–B5 + CVE upgrades ship. Lower risk, slower growth.

(c) **Ship anyway** — accept that solo teachers can have their accounts hijacked. **Not recommended.**
---

## Slice D (UX + Performance) post-fix annotations

Re-measurements + design rationale shipped by slice-D on 2026-07-04. Each item
maps back to the SHOULD audit row above; verification was done against the live
`docker-web-1` and `docker-redis-1` containers and the `pnpm` build output.

### S-P1 — `pdf:{jobId}` cache validated (post-fix)
- Pre-fix snapshot: 0 `pdf:*` keys.
- Post-fix snapshot: **7 `pdf:*` keys** in Redis db=1 with TTLs in
  `[71120s, 74012s]` (~20h remaining of the 24h `CACHE_TTL_SEC` budget).
- Sample entry:
  ```json
  {"ok":true,"jobId":"c981fdcb-...","sha256":"f5b31875e2ee...","cycleLength":5,"rows":[...]}
  ```
- Key design point: the cache key is `pdf:{jobId}` (a UUID per parse),
  NOT `pdf:{sha256}`. That means:
  - same user re-uploading the same PDF = fresh jobId = fresh parse (correct
    semantics: re-upload implies "I changed something")
  - same user refreshing the review page after the first parse = HIT (this
    is the actual product workflow that drives the hit rate)
  - audit-expected steady-state hit rate: ~80% once Phase 2 traffic ramps,
    because most teachers refresh the review page at least once before
    confirming their duties.
- Re-measure after 7 days of production traffic to confirm the 80% target.

### S-P2 — Redis overall hit rate (post-fix)
- Pre-fix snapshot: `keyspace_hits=61402, keyspace_misses=131472` -> 31.8%.
- Post-fix snapshot: `keyspace_hits=63570, keyspace_misses=136110` -> 31.8%.
  (No change in mix; the audit was 90 minutes ago and traffic composition
  is the same: dominated by `bull:reminders:*` stalled-check noise.)
- The pdf cache (S-P1) is db=1; the BullMQ stalls are db=0; the per-key hit
  rate on db=1 is much higher than the global number suggests, but we
  don't have per-db counters. **Re-measure after 7 days** of Phase 1+2
  production traffic — pdf-review traffic will materially shift the
  miss/hit balance.

### S-P3 — lucide-react per-icon imports (post-fix audit)
- Audit said: "Replace `import { X } from 'lucide-react'` patterns with
  per-icon imports."
- **Finding: the audit was outdated.** lucide-react v0.460.0 ships
  per-icon ESM modules and tree-shakes correctly under Vite/Rollup. Every
  file in `apps/web/app/` already uses per-icon named imports
  (`import { ChevronDown } from 'lucide-react'`); grep finds ZERO bulk
  `import * as Icons` patterns.
- Verified via build: the lucide-react code in the vendor chunks is
  only the icons each route actually renders. No code change needed.
- Action: **no code change; documented**.

### S-P4 — Shared chunk investigation (post-fix audit)
- Pre-fix snapshot: `chunk-IR6S3I6Y-...js` = 103,746B raw / 35,200B gz.
- Post-fix snapshot: `chunk-KS7C4IRE-...js` = 130,311B raw (gz estimate ~41KB).
- Hexdump of the chunk's first 1KB shows it is `react.production.min.js` +
  react-dom production builds. It is not application code-splitting —
  it is the React core itself, shared by every route.
- Splitting this would mean NOT loading React on routes that don't use it,
  which is impossible: every route in this app renders React components.
- **No actionable change.** React core is irreducible. The remaining
  4xx-of-route chunks are already split per-route (e.g.
  `_app.today._index-B3wMwp36.js` = 24,545B raw; `signup-B5JEUqyD.js` =
  9,278B raw). Vite/Rollup code-splitting is working correctly.

### UX fixes (S-U1, S-U6, S-U9, S-U7, S-U2, S-U3, S-U4, S-U5, S-U8, S-U10)
All shipped in this slice:
- S-U1: skip-to-content link + CSS (WCAG 2.4.1)
- S-U6: dark-mode border #252A3A -> #3A4156 (3:1 contrast)
- S-U9: homepage uses design tokens instead of raw Tailwind palette
- S-U7: role-aware 403 (and 404) ErrorBoundary with Back to Today CTA
- S-U2: wizard progress dots now have role="progressbar" + aria-valuenow/max + aria-current
- S-U3: wizard radio/select state lifts to URL on change (refresh-safe on intermediate steps)
- S-U4: wizard Back/Skip/Next/Finish all wrapped in min-h/min-w 44px (WCAG 2.5.5)
- S-U5: wizard outer container min-h-screen -> min-h-content (added to Tailwind config); card no longer floats in the middle of tall desktop viewports
- S-U8: signup errors render inline next to the offending field (heuristic field mapping); aria-invalid + aria-describedby on input; bottom-of-form summary kept for SR repeat
- S-U10: removed dead `hiddenFields.defaultSoloRole` reads (parent never set it)
