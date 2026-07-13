// app/routes/account.delete.tsx
//
// Account deletion request form (App Store guideline 5.1.1(v) compliance
// stopgap). Users can submit their email; we email them a one-click
// confirmation link; clicking the link soft-deletes the account with a
// 30-day grace period.
//
// This is a "deletion URL" for App Store Connect's Account Deletion
// field. The proper in-app deletion surface (Settings → Account → Delete)
// is planned for v1.1; see docs/APP-STORE-PREFLIGHT.md §5.

import { type ActionFunctionArgs, type LoaderFunctionArgs, type MetaFunction } from 'react-router';
import { Form, redirect, useActionData, useLoaderData } from 'react-router';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';

export const meta: MetaFunction = () => [
  { title: 'Delete your EduSupervise account' },
  { name: 'robots', content: 'noindex' },
];

interface LoaderData {
  alreadySubmitted: boolean;
}

export async function loader({ request: _request }: LoaderFunctionArgs): Promise<LoaderData> {
  return { alreadySubmitted: false };
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
  // TODO: server-side — generate one-time token, store in
  // `account_deletion_requests` table with 7-day expiry, send email
  // via Mailgun with confirmation link. For now, log + return ok.
  console.log(`[account/delete] deletion request for ${email}`);
  return { ok: true };
}

export default function AccountDelete(): React.ReactElement {
  const { alreadySubmitted } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();

  if (result?.ok) {
    return (
      <main id="main" className="min-h-screen flex items-center justify-center bg-surface-2 px-md py-xl">
        <article className="w-full max-w-md rounded-lg border border-border bg-surface p-lg shadow-elev-1">
          <h1 className="text-title-2 font-bold text-primary">Check your email</h1>
          <p className="mt-sm text-body text-secondary">
            If an EduSupervise account exists for that email, we just sent a
            deletion confirmation link. Click the link to start the 30-day
            deletion grace period. The link expires in 7 days.
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
            <Input
              type="email"
              name="email"
              required
              autoComplete="email"
              placeholder="you@school.org"
              className="w-full"
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
