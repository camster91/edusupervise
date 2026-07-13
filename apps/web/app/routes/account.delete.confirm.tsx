// app/routes/account.delete.confirm.tsx
//
// Confirmation route for the account deletion flow. User clicks the
// link in the email; we validate the one-time token and either:
//   - confirm the deletion (set pending_deletion_at = now() + 30d)
//   - show an error if the token is invalid / expired / already used
//
// Server function: see apps/web/server/account-deletion.server.ts.

import { type LoaderFunctionArgs, type MetaFunction } from 'react-router';
import { Link, useLoaderData } from 'react-router';
import { confirmAccountDeletion } from '../../server/account-deletion.server';

export const meta: MetaFunction = () => [
  { title: 'Account deletion — EduSupervise' },
  { name: 'robots', content: 'noindex' },
];

interface LoaderData {
  ok: boolean;
  error?: 'invalid_token' | 'expired_token' | 'already_used' | 'gone';
  deletionAt?: string;  // ISO date, only on success
}

export async function loader({ request }: LoaderFunctionArgs): Promise<LoaderData> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') ?? '';
  if (!token) return { ok: false, error: 'invalid_token' };

  try {
    const result = await confirmAccountDeletion(token);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, deletionAt: result.deletionAt.toISOString() };
  } catch (err) {
    console.error('[account/delete/confirm] loader failed', err);
    return { ok: false, error: 'invalid_token' };
  }
}

export default function AccountDeleteConfirm(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const deletionDate = data.deletionAt
    ? new Date(data.deletionAt).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : null;

  if (data.ok) {
    return (
      <main id="main" className="min-h-screen flex items-center justify-center bg-surface-2 px-md py-xl">
        <article className="w-full max-w-md rounded-lg border border-border bg-surface p-lg shadow-elev-1">
          <h1 className="text-title-2 font-bold text-success">Deletion confirmed</h1>
          <p className="mt-sm text-body text-secondary">
            Your EduSupervise account is scheduled for permanent deletion
            on <strong className="text-primary">{deletionDate}</strong>.
            After that date, your account, calendar, duties, and notifications
            will be permanently deleted.
          </p>
          <p className="mt-sm text-body text-secondary">
            You have until then to cancel. To cancel, sign in and visit
            Settings → Account → Cancel deletion.
          </p>
          <p className="mt-md">
            <Link to="/login" className="text-accent underline">
              Sign in to manage your account
            </Link>
          </p>
        </article>
      </main>
    );
  }

  // Error states
  const errorMessage = {
    invalid_token: 'That link is no longer valid. Request a new one below.',
    expired_token: 'That link has expired. Request a new one below.',
    already_used: 'That link was already used. Your deletion may already be in progress — sign in to check.',
    gone: 'Your account is no longer in our system.',
  }[data.error ?? 'invalid_token'];

  return (
    <main id="main" className="min-h-screen flex items-center justify-center bg-surface-2 px-md py-xl">
      <article className="w-full max-w-md rounded-lg border border-border bg-surface p-lg shadow-elev-1">
        <h1 className="text-title-2 font-bold text-primary">We can't complete that</h1>
        <p className="mt-sm text-body text-secondary">{errorMessage}</p>
        <p className="mt-md">
          <Link to="/account/delete" className="text-accent underline">
            Request a new deletion link
          </Link>
        </p>
        <p className="mt-sm text-callout text-tertiary">
          Or{' '}
          <Link to="/login" className="text-accent underline">
            sign in
          </Link>
          .
        </p>
      </article>
    </main>
  );
}
