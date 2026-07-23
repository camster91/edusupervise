// apps/web/app/routes/logout.tsx — clears the session + CSRF cookies and redirects to /login.
import { redirect } from 'react-router';
import { clearSessionCookie } from '../../server/auth.server';
import type { Route } from './+types/logout';
import {
  clearCsrfCookie,
  validateCsrfWithFormToken,
} from '../../server/csrf.server';

export async function action({ request }: Route.ActionArgs) {
  // CSRF check. Logout is a state-changing operation per spec section
  // 5 — it should not be triggerable by a cross-origin attacker who
  // tricks the user into clicking a link to /logout.
  const form = await request.formData();
  const csrf = validateCsrfWithFormToken(request, form);
  if (!csrf.ok) return csrf.response;

  // Audit 2026-07-22 P3-2: clear both cookies so the double-submit token
  // doesn't outlive the session. A logged-out victim kept their CSRF
  // token in document.cookie for the full 24h TTL after this fix landed.
  const headers = new Headers();
  headers.append('Set-Cookie', clearSessionCookie());
  headers.append('Set-Cookie', clearCsrfCookie());
  return redirect('/login', { headers });
}

export async function loader() {
  return redirect('/login', {
    headers: { 'Set-Cookie': clearCsrfCookie() },
  });
}