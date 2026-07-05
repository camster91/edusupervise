-- 03-pg-stat-statements.sql
-- Enable pg_stat_statements for query performance monitoring (H-DB-1).
-- Loaded by the postgres container's docker-entrypoint-initdb.d on first init.
-- For a cluster already initialized, this needs to be added to postgresql.conf
-- directly AND the cluster restarted. See audit H-DB-1 follow-up.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
