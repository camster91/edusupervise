// apps/web/app/routes/logout.tsx — clears the session cookie and redirects to /login.
import { redirect } from 'react-router';
import type { Route } from './+types/logout';
import { validateCsrfWithFormToken } from '../../server/csrf.server';

export async function action({ request }: Route.ActionArgs) {
  // CSRF check. Logout is a state-changing operation per spec section
  // 5 — it should not be triggerable by a cross-origin attacker who
  // tricks the user into clicking a link to /logout.
  const form = await request.formData();
  const csrf = validateCsrfWithFormToken(request, form);
  if (!csrf.ok) return csrf.response;

  return redirect('/login', {
    headers: { 'Set-Cookie': 'edusupervise.session=; Path=/; HttpOnly; Max-Age=0' },
  });
}

export async function loader() {
  return redirect('/login');
}