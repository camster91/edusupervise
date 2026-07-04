-- Migration 0011: RLS for the auth_session table (audit S-S3)
--
-- Per the audit (2026-07-04, S-S3), auth_session is keyed by an opaque
-- session token and has no direct `school_id` column — the user it
-- belongs to lives in `public.users`. That means the canonical
-- `school_id = current_school_id()` policy from migration 0004/0010
-- cannot be applied directly. But the audit's defense-in-depth goal
-- (prevent the runtime role from leaking another school's session rows)
-- is still achievable: we add a subquery policy that joins through
-- users.school_id.
--
-- POLICY SHAPE
--   USING      ("userId" IN (SELECT id FROM users WHERE school_id = current_school_id()))
--   WITH CHECK ("userId" IN (SELECT id FROM users WHERE school_id = current_school_id()))
--
-- NOTE on column name: the auth_session."userId" column is camelCase
-- (declared with quoted identifiers in migration 0001, matching the
-- drizzle schema). We quote it here too. Snake-case aliases via SELECT
-- would also work, but quoting is the minimal-diff option.
--
-- This means:
--   - runtime role: can only see sessions for users in the currently-set
--     school (current_school_id() = NULL → sees zero rows, exactly the
--     same behavior as the other tenant tables).
--   - system role (BYPASSRLS, used at sign-in time before we know the
--     user's school): still sees every row. That's the whole point of
--     BYPASSRLS — it's the bootstrap path for cross-tenant session
--     lookup.
--
-- WHY THIS MATTERS
--   Without RLS, any code path that touches auth_session via the
--   runtime role (a future refactor that "optimises" the lookup by
--   dropping the system role, a mistake in a new endpoint, a debug
--   script that hits the production DB) would silently leak every
--   active session token in the system. Tokens are HMAC-signed but
--   not encrypted, so a leaked token = full account takeover of the
--   user it belongs to.
--
-- AUDIT_VERIFICATION
--   After this migration runs, a query like
--     SET LOCAL ROLE edusupervise_runtime;
--     SELECT count(*) FROM auth_session;  -- returns 0 (no school set)
--   must succeed and return 0. The system role still sees all rows.
--
-- IDEMPOTENT
--   DROP POLICY IF EXISTS + ALTER TABLE ... ENABLE/FORCE are idempotent
--   in Postgres, so re-running this migration is safe.

DO $$
BEGIN
  -- Enable RLS on auth_session (it had no RLS at all).
  EXECUTE 'ALTER TABLE auth_session ENABLE ROW LEVEL SECURITY';
  -- FORCE so the table owner (edusupervise_owner) doesn't bypass RLS.
  -- The runtime role doesn't own tables, so without FORCE the runtime
  -- would silently bypass the policy in any code path that bypassed
  -- BYPASSRLS — same reasoning as migration 0004.
  EXECUTE 'ALTER TABLE auth_session FORCE  ROW LEVEL SECURITY';

  -- Drop any prior copy of the policy so this migration is re-runnable.
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON auth_session';

  -- The policy: a session row is visible iff its user belongs to the
  -- current school. Subquery is fine — Postgres evaluates it per-row
  -- using the `users_school_id_idx` index on users.school_id, so the
  -- join stays O(matched users) rather than O(all users).
  EXECUTE $POL$
    CREATE POLICY tenant_isolation ON auth_session
      USING (
        "userId" IN (
          SELECT id FROM users WHERE school_id = current_school_id()
        )
      )
      WITH CHECK (
        "userId" IN (
          SELECT id FROM users WHERE school_id = current_school_id()
        )
      )
  $POL$;
END
$$;

-- ---------------------------------------------------------------------------
-- GRANTS — runtime + system roles both need DML on auth_session so the
-- existing login + logout flows continue to work after RLS is on.
-- runtime writes here are gated by the policy above (current_school_id
-- must match the user's school), so a runtime role call from outside
-- the right school context becomes a no-op rather than a data leak.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.auth_session TO edusupervise_runtime';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.auth_session TO edusupervise_system';
EXCEPTION
  WHEN duplicate_object THEN null;
  WHEN undefined_object THEN null;
END
$$;