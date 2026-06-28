// apps/web/app/routes/logout.tsx — clears the session cookie and redirects to /login.
import { redirect } from 'react-router';
import type { Route } from './+types/logout';

export async function action(_: Route.ActionArgs) {
  return redirect('/login', {
    headers: { 'Set-Cookie': 'edusupervise.session=; Path=/; HttpOnly; Max-Age=0' },
  });
}

export async function loader() {
  return redirect('/login');
}