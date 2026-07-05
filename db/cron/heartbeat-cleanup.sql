-- Nightly worker_heartbeats cleanup. Removes stale rows (>7 days old)
-- so the table doesn't accumulate dead tuples forever. Auto-vacuum handles
-- most bloat but the row count itself still grows.
DELETE FROM worker_heartbeats
 WHERE last_beat < now() - interval '7 days';
