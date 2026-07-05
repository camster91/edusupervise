# edusupervise — Migration 0013 deliverable bundle

**Author:** Database Engineer
**Date:** 2026-07-05 04:30 EDT
**For:** sync + commit to `/opt/edusupervise/` on root@vps.ashbi.ca

## Files in this bundle

| Local path | Lands on VPS at | Purpose |
| --- | --- | --- |
| `packages/db/migrations/0013_cycle_calendar_columns.sql` | `packages/db/migrations/0013_cycle_calendar_columns.sql` | The migration — new columns + backfill + CHECK + partial index |
| `packages/db/src/schema.ts` | `packages/db/src/schema.ts` | Drizzle table extension (replace, not merge) |
| `db-design/rls-check.md` | `docs/db-design/rls-check-0013.md` (or wherever the team keeps design docs) | RLS verification writeup |
| `journal-update.md` | n/a — run the commands inside it | Patch to append the 0013 entry to `meta/_journal.json` |

## Migration index
- idx: 13
- tag: `0013_cycle_calendar_columns`
- when: `1783239969440` (2026-07-05 04:26 EDT)
- version: `7`
- breakpoints: `true`

## Apply order

```bash
# 0) Pull the latest from origin/main (or wherever 0012_drop_redundant_indexes lives)
cd /opt/edusupervise
git pull

# 1) Copy the new migration SQL
mkdir -p packages/db/migrations
# copy 0013_cycle_calendar_columns.sql into packages/db/migrations/

# 2) Append the journal entry — see journal-update.md for the jq one-liner
# (or paste the JSON block manually)

# 3) Replace packages/db/src/schema.ts with the version in this bundle
#    (the new file contains both the old schema AND the 0013 additions;
#    do NOT try to merge line-by-line)

# 4) Stash db-design/rls-check.md into your docs directory

# 5) Smoke-test on staging BEFORE prod
psql "$STAGING_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -f packages/db/migrations/0013_cycle_calendar_columns.sql

# 6) Verify (see "Verification" in rls-check.md):
psql "$STAGING_DATABASE_URL" -c "
  SELECT count(*) FILTER (WHERE is_instructional = is_school_day) AS synced,
         count(*) AS total
    FROM cycle_calendar;
"

# 7) Deploy to prod (during a low-traffic window — the migration is online-safe,
#    but the backfill UPDATE will briefly lock rows on a hot table)
psql "$PROD_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -f packages/db/migrations/0013_cycle_calendar_columns.sql

# 8) Commit
git add packages/db/migrations/0013_cycle_calendar_columns.sql
git add packages/db/migrations/meta/_journal.json
git add packages/db/src/schema.ts
git add docs/db-design/rls-check-0013.md  # or wherever it lands
git commit -m "feat(db): cycle_calendar is_instructional + holiday_code (0013)"
```

## Rollback

See `db-design/rls-check.md` for the rollback SQL. Short version:

```sql
ALTER TABLE cycle_calendar DROP CONSTRAINT IF EXISTS cycle_calendar_holiday_code_values;
ALTER TABLE cycle_calendar DROP CONSTRAINT IF EXISTS cycle_calendar_holiday_code_length;
DROP INDEX IF EXISTS idx_cycle_calendar_non_instructional;
ALTER TABLE cycle_calendar DROP COLUMN IF EXISTS holiday_code;
ALTER TABLE cycle_calendar DROP COLUMN IF EXISTS is_instructional;
```

Also drop the journal entry from `meta/_journal.json` if you haven't shipped prod yet. If you have shipped prod, **do not** rewrite the journal — instead ship migration 0014 that performs the inverse.