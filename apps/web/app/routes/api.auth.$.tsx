// app/routes/api.auth.$.tsx — better-auth catch-all resource route.
//
// Mounts better-auth's REST API at /api/auth/*. Better-auth exposes a
// set of standard endpoints (sign-up, sign-in, sign-out, session,
// forget-password, reset-password, verify-email, magic-link, OAuth
// callbacks) that the client SDK + the form actions in this app use.
//
// We catch any path under /api/auth and forward the Request to
// better-auth's handler. The handler returns a Response (with the right
// Set-Cookie headers for session cookies); we forward it unchanged.

import type { LoaderFunctionArgs, ActionFunctionArgs } from 'react-router';

import { getAuth } from '~/server/auth.server';

/**
 * GET handler — e.g. /api/auth/get-session, /api/auth/sign-in/google,
 * OAuth callbacks.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const auth = getAuth();
  return auth.handler(request);
}

/**
 * POST handler — sign-up, sign-in, sign-out, magic-link request,
 * password reset, etc.
 */
export async function action({ request }: ActionFunctionArgs) {
  const auth = getAuth();
  return auth.handler(request);
}