/**
 * Better-auth-facing schema object.
 *
 * Test fixture / schema bundle for the auth tables. Exposes the four
 * better-auth tables (`user`, `session`, `account`, `verification`)
 * under their canonical model names. The integration tests in
 * `tests/integration/auth-rls.test.ts` consume this when seeding
 * auth-related fixtures directly (e.g. password-reset verification rows
 * via `authSchema.verification`).
 *
 * Note: the production auth flow in `apps/web/server/auth.server.ts`
 * currently uses bcrypt + HMAC sessions (no better-auth). This export
 * is retained for tests + a Tier 1.5 better-auth upgrade path.
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