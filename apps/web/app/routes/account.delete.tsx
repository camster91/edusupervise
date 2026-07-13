// app/routes/account.delete.tsx
//
// Account deletion request form (App Store guideline 5.1.1(v) compliance
// stopgap). Users can submit their email; we email them a one-click
// confirmation link; clicking the link soft-deletes the account with a
// 30-day grace period.
//
// Server function: see apps/web/server/account-deletion.server.ts.
// Confirmation route: see apps/web/app/routes/account.delete.confirm.tsx.

import { type ActionFunctionArgs, type LoaderFunctionArgs, type MetaFunction } from 'react-router';
import { Form, useActionData } from 'react-router';
import { Button } from '../components/ui/Button';
import { requestAccountDeletion } from '../../server/account-deletion.server';

export const meta: MetaFunction = () => [
  { title: 'Delete your EduSupervise account' },
  { name: 'robots', content: 'noindex' },
];

export async function loader(_args: LoaderFunctionArgs): Promise<null> {
  return null;
}

interface ActionData {
  ok: boolean;
  error?: string;
}

export async function action({ request }: ActionFunctionArgs): Promise<ActionData> {
  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Enter a valid email address.' };
  }
  try {
    const result = await requestAccountDeletion(email);
    if (!result.ok) {
      if (result.error === 'rate_limited') {
        return {
          ok: false,
          error: 'Too many requests. Check your email or wait 24 hours and try again.',
        };
      }
      if (result.error === 'invalid_email') {
        return { ok: false, error: 'Enter a valid email address.' };
      }
      return { ok: false, error: 'Something went wrong. Try again in a minute.' };
    }
    return { ok: true };
  } catch (err) {
    console.error('[account/delete] action failed', err);
    return { ok: false, error: 'Something went wrong. Try again in a minute.' };
  }
}

export default function AccountDelete(): React.ReactElement {
  const result = useActionData<typeof action>();

  if (result?.ok) {
    return (
      <main id="main" className="min-h-screen flex items-center justify-center bg-surface-2 px-md py-xl">
        <article className="w-full max-w-md rounded-lg border border-border bg-surface p-lg shadow-elev-1">
          <h1 className="text-title-2 font-bold text-primary">Check your email</h1>
          <p className="mt-sm text-body text-secondary">
            We just sent a confirmation link to the address you provided.
            Click it within 7 days to start the 30-day deletion grace period.
            After 30 days, your account, calendar, duties, and notifications
            are permanently deleted.
          </p>
          <p className="mt-md text-callout text-tertiary">
            Didn't get the email? Check spam, or email{' '}
            <a className="text-accent underline" href="mailto:support@edusupervise.ashbi.ca">support@edusupervise.ashbi.ca</a>.
          </p>
        </article>
      </main>
    );
  }

  return (
    <main id="main" className="min-h-screen flex items-center justify-center bg-surface-2 px-md py-xl">
      <article className="w-full max-w-md rounded-lg border border-border bg-surface p-lg shadow-elev-1">
        <h1 className="text-title-2 font-bold text-primary">Delete your EduSupervise account</h1>
        <p className="mt-sm text-body text-secondary">
          Enter the email on your account. We'll send a confirmation link.
          Clicking the link starts a 30-day grace period. After 30 days, your
          account, calendar, duties, and notifications are permanently deleted.
        </p>
        <p className="mt-sm text-body text-secondary">
          You can cancel the deletion during the 30-day window by signing in
          and clicking "Cancel deletion" in Settings.
        </p>
        <Form method="post" className="mt-lg flex flex-col gap-md">
          <label className="flex flex-col gap-xs">
            <span className="text-callout font-medium text-primary">Email</span>
            <input
              type="email"
              name="email"
              required
              autoComplete="email"
              placeholder="you@school.org"
              aria-label="Email address"
              className="w-full h-input px-md rounded-md border border-border bg-surface text-primary placeholder:text-tertiary focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </label>
          {result?.error && (
            <p role="alert" className="text-callout text-error">{result.error}</p>
          )}
          <Button type="submit" variant="primary" className="w-full">
            Send deletion link
          </Button>
        </Form>
        <p className="mt-lg text-callout text-tertiary">
          Changed your mind?{' '}
          <a className="text-accent underline" href="/login">Sign back in</a>.
        </p>
      </article>
    </main>
  );
}
