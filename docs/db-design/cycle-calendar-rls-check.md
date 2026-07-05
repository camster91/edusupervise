# RLS Check — Migration 0013 cycle_calendar_columns

**Author:** Database Engineer
**Date:** 2026-07-05
**Migration:** `0013_cycle_calendar_columns.sql`
**Scope:** Verify the new `is_instructional` + `holiday_code` columns on `cycle_calendar` are protected by the existing `tenant_isolation` RLS policy without any new policy needed.

---

## TL;DR

**No new RLS policy is required.** The existing `tenant_isolation` policy on `cycle_calendar` (defined in `db/init/02-schema.sql` via the dynamic DO-block that loops over every tenant table) operates at the **row level** using `school_id`. It applies to every column on the table — pre-existing and newly added — automatically. The Migration 0013 columns inherit the same protection the existing `date`, `cycle_day`, `is_school_day`, and `note` columns already enjoy.

---

## The existing policy

From `db/init/02-schema.sql` (lines 311-331):

```sql
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'cycle_calendar', 'duties', 'duty_assignments',
    'reminders', 'reminder_log', 'audit_log', 'notifications',
    'push_subscriptions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING      (school_id = current_school_id()) '
      'WITH CHECK (school_id = current_school_id())',
      t
    );
  END LOOP;
END
$$;
```

Key observations:

1. **`ENABLE ROW LEVEL SECURITY`** turns on RLS for the table.
2. **`FORCE ROW LEVEL SECURITY`** makes the policy apply even to the table owner (defends against the footgun where the table owner bypasses RLS).
3. **The policy is a single `USING` + `WITH CHECK` predicate on `school_id`.** It has no per-column `SELECT` / `INSERT` / `UPDATE` lists — every column on the row is gated by the same `school_id = current_school_id()` test.

Because (3) is column-agnostic, **any column added in a later migration inherits the policy with zero additional work**. The runtime role can SELECT / INSERT / UPDATE / DELETE only on rows whose `school_id` matches `app.school_id` (the per-request GUC set by `requestContext.server.ts`); the new `is_instructional` and `holiday_code` columns participate in that gate like every other column on the row.

---

## Migration 0013 specifics

The migration does:

| Change | Effect on RLS |
| --- | --- |
| `ALTER TABLE cycle_calendar ADD COLUMN is_instructional boolean NOT NULL DEFAULT true` | New column. Policy applies to it automatically. |
| `ALTER TABLE cycle_calendar ADD COLUMN holiday_code text` | New column. Policy applies to it automatically. |
| `UPDATE cycle_calendar SET is_instructional = is_school_day WHERE ...` | Runs as `edusupervise_system` (the role that owns migrations), which is the **table owner** — and FORCE ROW LEVEL SECURITY still applies to the owner, but the system role runs the migration with the policy satisfied because no `app.school_id` GUC is set (function returns NULL → predicate is NULL → rows are filtered out). **This is a known hazard and the reason the migration runs as system, not runtime.** See Verification #3 below. |
| `ALTER TABLE cycle_calendar ADD CONSTRAINT cycle_calendar_holiday_code_values CHECK (...)` | CHECK is column-shape, not row-visibility. RLS unaffected. |
| `CREATE INDEX idx_cycle_calendar_non_instructional ON cycle_calendar (school_id, date) WHERE is_instructional = false` | New index. RLS predicate still applies at scan time. |

---

## Verification (run after migration deploys)

### 1. RLS still enabled and forced

```sql
SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class
 WHERE relname = 'cycle_calendar';
```

Expected:

```
    relname     | relrowsecurity | relforcerowsecurity
----------------+----------------+---------------------
 cycle_calendar | t              | t
```

If `relforcerowsecurity` is `f`, the table owner bypasses RLS — re-apply `ALTER TABLE cycle_calendar FORCE ROW LEVEL SECURITY;` before continuing.

### 2. Policy still present and unchanged

```sql
SELECT polname, polcmd, polqual::text, polwithcheck::text
  FROM pg_policy
 WHERE polrelid = 'public.cycle_calendar'::regclass;
```

Expected (the `polcmd` of `r` = ALL means SELECT/INSERT/UPDATE/DELETE all share the same predicate):

```
     polname      | polcmd |          polqual           |         polwithcheck
------------------+--------+----------------------------+-----------------------------
 tenant_isolation | r      | (school_id = current_school_id()) | (school_id = current_school_id())
```

The new columns appear nowhere here, and they don't need to: the predicate gates the whole row, regardless of which columns the SELECT / INSERT references.

### 3. Migration backfill UPDATE respects FORCE RLS

The backfill `UPDATE` runs as the `edusupervise_system` role. With FORCE RLS on, the system role is also subject to the `tenant_isolation` predicate. We need to confirm the UPDATE actually rewrites every row, not just the rows visible to one school at a time.

```sql
-- Before
SELECT count(*) AS total, count(*) FILTER (WHERE is_instructional = is_school_day) AS synced
  FROM cycle_calendar;

-- After migration
SELECT count(*) AS total, count(*) FILTER (WHERE is_instructional = is_school_day) AS synced
  FROM cycle_calendar;
```

Both columns must equal the `total`. If they diverge, the migration was run as a role that had `BYPASSRLS` or that owns the table without FORCE, and the backfill only rewrote visible rows.

**Defence in depth:** the migration sets `\set ON_ERROR_STOP on` and is run as a role that owns `cycle_calendar` (typically the DB superuser, the same role that ran `db/init/02-schema.sql`). Postgres superusers `BYPASSRLS` by default, so FORCE ROW LEVEL SECURITY is invisible to the migration runner and the backfill rewrites every row regardless.

This matches the pattern already used by migration 0006 (`0006_signup_and_demo.sql`), which has the same DO-block backfill on `schools` and ships without `SET LOCAL row_security = off`. The verifier should confirm the migration runner on /opt/edusupervise is a superuser (most likely — it's whatever role the deployment script uses to apply SQL files). If it isn't, wrap the backfill like:

```sql
BEGIN;
SET LOCAL row_security = off;
UPDATE cycle_calendar SET is_instructional = is_school_day
 WHERE is_instructional IS DISTINCT FROM is_school_day;
COMMIT;
```

### 4. New columns actually visible under the runtime role

```sql
-- Switch to runtime role + school context
SET ROLE edusupervise_runtime;
SET app.school_id = '<a real school uuid>';

-- The new columns are part of every SELECT
SELECT date, is_instructional, holiday_code
  FROM cycle_calendar
 ORDER BY date
 LIMIT 5;

-- A different school must return 0 rows (existing behaviour, unchanged)
SET app.school_id = '<a different school uuid>';
SELECT count(*) FROM cycle_calendar;
-- expect: 0

RESET ROLE;
RESET app.school_id;
```

### 5. New columns respect FORCE RLS too

Insert a row into `cycle_calendar` for school A while pretending to be school B. With FORCE RLS on, the WITH CHECK predicate `(school_id = current_school_id())` rejects the row.

```sql
SET ROLE edusupervise_runtime;
SET app.school_id = '<school B uuid>';

INSERT INTO cycle_calendar (school_id, date, is_instructional, holiday_code)
  VALUES ('<school A uuid>', '2026-09-15', false, 'holiday');
-- expect: ERROR: new row violates row-level security policy for table "cycle_calendar"

RESET ROLE;
RESET app.school_id;
```

---

## Conclusion

Migration 0013 is **RLS-safe by inheritance**. The existing `tenant_isolation` policy covers `is_instructional` and `holiday_code` with no additional SQL. The only RLS-related verification work post-deploy is:

1. Confirm `relforcerowsecurity = t` on `cycle_calendar`.
2. Confirm the backfill UPDATE actually rewrote every row (run as a role with `BYPASSRLS` or with `SET LOCAL row_security = off`).
3. Spot-check that the new columns are visible under the runtime role + `app.school_id` and hidden under a different `app.school_id`.

If all three pass, ship it.

---

## Cross-references

- `db/init/02-schema.sql` lines 86-97 — original `cycle_calendar` table definition
- `db/init/02-schema.sql` lines 311-331 — the RLS DO-block that creates `tenant_isolation`
- `packages/db/migrations/0013_cycle_calendar_columns.sql` — the migration
- `packages/db/src/schema.ts` — Drizzle table declaration, mirror of the SQL
- `apps/web/server/requestContext.server.ts` — sets `app.school_id` per request