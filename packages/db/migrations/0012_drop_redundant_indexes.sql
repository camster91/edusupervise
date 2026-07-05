-- 0012_drop_redundant_indexes.sql (H-DB-4)
-- Both idx_schools_slug and idx_cycle_calendar_school_date duplicate
-- unique indexes on the same columns. Postgres can use the unique
-- index for any read the non-unique one would handle, so the non-unique
-- index is pure write overhead.
-- Verified via grep: no app code references these index names directly
-- (schema.ts has the definition but no USAGES).
DROP INDEX IF EXISTS idx_schools_slug;
DROP INDEX IF EXISTS idx_cycle_calendar_school_date;
