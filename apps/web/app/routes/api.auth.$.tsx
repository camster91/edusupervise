// apps/web/app/routes/api.auth.$.tsx — catch-all route for better-auth.
//
// Better-auth mounts its own router at /api/auth/* and exposes a single
// `handler(request: Request): Promise<Response>` that dispatches to the
// right endpoint based on the URL path. We pass through the incoming
// request and forward the response.
//
// This route also handles OAuth callbacks (Google, Microsoft) which
// better-auth exposes at /api/auth/oauth/callback/:providerId.
//
// Why a catch-all ($):
//   - Better-auth has ~30 endpoints under /api/auth/* (sign-in, sign-up,
//     sign-out, magic-link/verify, oauth/*, email-verification, etc.).
//     Mounting a single catch-all and forwarding to better-auth's
//     dispatch keeps us from manually wiring each one.

import type { Route } from './+types/api.auth.$';

import { getAuth } from '~/server/auth.server';

export async function loader({ request }: Route.LoaderArgs) {
  return getAuth().handler(request);
}

export async function action({ request }: Route.ActionArgs) {
  return getAuth().handler(request);
}