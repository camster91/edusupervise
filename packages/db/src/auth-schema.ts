/**
 * Better-auth-facing schema object.
 *
 * Better-auth's drizzle adapter looks up tables by model name. Its default
 * model names are `user`, `session`, `account`, `verification` — singular,
 * even when `usePlural: true` is set on the adapter. We map those to the
 * concrete Drizzle tables here so the auth layer can resolve them without
 * us renaming our tables.
 *
 * Why the keys are the singular form (not `users` / `authSession`):
 *   - The adapter does `config.schema[modelName]` literally; if modelName
 *     is `user` the key must be exactly `user` (not `users`).
 *   - Our Drizzle schema uses snake_case SQL table names but camelCase JS
 *     identifiers (`authSession` for SQL `auth_session`). The lookup is
 *     against the JS object key, so we re-export under the better-auth
 *     canonical names here.
 *
 * Why `authSchema` is separate from the main `schema` export:
 *   - The main `schema` export is consumed by drizzle-kit migrations and
 *     Drizzle's relational query API; mixing better-auth-specific keys in
 *     would shadow our camelCase identifiers (`cycleCalendar`, `dutyAssignments`)
 *     and confuse downstream consumers.
 *   - Auth-schema wiring lives next to the auth code in apps/web; this
 *     file is just the typed pointer.
 */
import {
  users,
  authSession,
  authAccount,
  authVerification,
} from './schema.js';

export const authSchema = {
  user: users,
  session: authSession,
  account: authAccount,
  verification: authVerification,
} as const;

export type AuthSchema = typeof authSchema;