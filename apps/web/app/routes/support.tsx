// apps/web/app/routes/support.tsx — public support page.
//
// Publicly accessible (no auth) — App Store Connect's "Support URL"
// must resolve to a real page. We use this to host:
//   - the support email
//   - a short FAQ (the most common questions, to deflect simple tickets)
//   - status-page link (once we have one)
//   - docs link (once we have docs)
//
// The same email routes to support@edusupervise.ashbi.ca as the
// privacy contact (privacy@...), but the addresses are different
// aliases so we can route inbox rules separately.

import { Link } from 'react-router';
import type { Route } from './+types/support';

export function meta() {
  return [
    { title: 'Support — EduSupervise' },
    {
      name: 'description',
      content:
        'How to get help with EduSupervise — email, FAQs, status page.',
    },
  ];
}

const SUPPORT_EMAIL = 'support@edusupervise.ashbi.ca';
const PRIVACY_EMAIL = 'privacy@edusupervise.ashbi.ca';

export async function loader() {
  return { supportEmail: SUPPORT_EMAIL, privacyEmail: PRIVACY_EMAIL };
}

export default function SupportPage({ loaderData }: Route.ComponentProps) {
  const { supportEmail, privacyEmail } = loaderData;
  return (
    <a href="#main" className="skip-link sr-only focus:not-sr-only focus:absolute focus:top-md focus:left-md focus:z-50 focus:bg-accent focus:text-on-accent focus:px-md focus:py-xs focus:rounded">Skip to content</a>
    <main
      id="main"
      tabIndex={-1}
      className="min-h-screen bg-bg text-primary"
    >
      <article className="mx-auto max-w-3xl px-md py-2xl">
        <Link to="/" className="text-sm text-accent hover:underline">
          ← Back to EduSupervise
        </Link>

        <header className="mt-lg mb-2xl">
          <h1 className="text-display font-bold tracking-tight">Support</h1>
          <p className="mt-sm text-callout text-secondary">
            Something not working? Read the FAQs below — they cover the
            common ones. If not, email us. We read every message.
          </p>
        </header>

        <ContactCard
          email={supportEmail}
          subject="How can we help?"
          body="What you were trying to do, what happened instead, and a screenshot if you have one."
        />

        <section className="mt-2xl">
          <h2 className="text-title-2 font-semibold tracking-tight text-primary">
            Common questions
          </h2>

          <FAQ
            q="I'm not getting duty reminders on my phone."
            a={
              <>
                <p>
                  Three things to check, in order:
                </p>
                <ol className="mt-md list-decimal space-y-xs pl-lg">
                  <li>
                    Open EduSupervise on your phone, go to Profile →
                    Notifications, and make sure "Duty reminders" is
                    toggled on.
                  </li>
                  <li>
                    On iOS, check Settings → Notifications → EduSupervise
                    and make sure notifications are allowed (not muted).
                  </li>
                  <li>
                    On Android, make sure battery optimization isn't
                    suspending the EduSupervise background process.
                  </li>
                </ol>
                <p className="mt-md">
                  If all three look right and reminders still don't fire,
                  email us with a screenshot of Profile → Notifications
                  and the device + OS version.
                </p>
              </>
            }
          />

          <FAQ
            q="I added a teacher but they never got an invite email."
            a={
              <>
                <p>
                  Check your school's spam folder first. If it's not
                  there, the email was either (a) rejected by their mail
                  server (most common: corporate spam filters blocking
                  our domain) or (b) the email address has a typo.
                </p>
                <p className="mt-md">
                  Ask the teacher to check their mail server's quarantine,
                  or have them log in directly via the join link you sent.
                </p>
              </>
            }
          />

          <FAQ
            q="How do I export my school's data?"
            a={
              <p>
                School admins: Settings → School → Export. The export is
                a JSON file with all your duty history, coverage
                decisions, and audit log entries. The same page has the
                option to delete the school (cascades to all data
                within 30 days).
              </p>
            }
          />

          <FAQ
            q="Can I move my school to a different account?"
            a={
              <p>
                Yes. Email us with the school name and the email
                addresses of the current and new admin. We'll do the
                transfer manually and confirm with both addresses before
                removing the old admin.
              </p>
            }
          />

          <FAQ
            q="The iOS app is just a web wrapper, isn't it?"
            a={
              <>
                <p>
                  Mostly yes — the iOS app loads the same EduSupervise you
                  see in Safari. We use Apple's recommended approach
                  (WKWebView) for the web surface, with native iOS push
                  notifications on top so duty reminders arrive even when
                  the app is closed.
                </p>
                <p className="mt-md">
                  Subscription management is intentionally Safari-only.
                  Apple's App Store rules would require us to use In-App
                  Purchase (and pay Apple 15-30%) if we sold
                  subscriptions inside the iOS app. We chose the
                  Safari-handles-billing route so the price you pay is
                  the price we charge, with no commission layered on.
                </p>
              </>
            }
          />

          <FAQ
            q="Where can I read your privacy policy?"
            a={
              <p>
                <Link to="/privacy" className="text-accent hover:underline">
                  Read the full policy
                </Link>
                . For privacy-specific questions (data export, deletion,
                complaints), email{' '}
                <a
                  className="text-accent hover:underline"
                  href={`mailto:${privacyEmail}`}
                >
                  {privacyEmail}
                </a>
                .
              </p>
            }
          />
        </section>

        <section className="mt-2xl rounded-2xl border border-border bg-card p-xl">
          <h2 className="text-title-2 font-semibold tracking-tight text-primary">
            Status + uptime
          </h2>
          <p className="mt-md text-body">
            We run a public status page at{' '}
            <a
              className="text-accent hover:underline"
              href="https://status.edusupervise.ashbi.ca"
              rel="noreferrer"
            >
              status.edusupervise.ashbi.ca
            </a>{' '}
            (UptimeRobot mirror — historical uptime, scheduled
            maintenance). Subscribe for incident notifications.
          </p>
        </section>

        <footer className="mt-3xl border-t border-border pt-xl text-callout text-secondary">
          <p>
            Ashbi Inc. · Toronto, Canada. We respond to support emails
            within 1 business day. Privacy requests within 5 business
            days.
          </p>
        </footer>
      </article>
    </main>
  );
}

function ContactCard({
  email,
  subject,
  body,
}: {
  email: string;
  subject: string;
  body: string;
}) {
  const mailto = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return (
    <a
      href={mailto}
      className="block rounded-2xl border border-border bg-card p-xl transition-colors hover:bg-surface-2"
    >
      <p className="text-callout text-secondary">Email us</p>
      <p className="mt-xs text-title-3 font-semibold text-primary">{email}</p>
      <p className="mt-sm text-body text-secondary">
        {body}
      </p>
    </a>
  );
}

function FAQ({ q, a }: { q: string; a: React.ReactNode }) {
  return (
    <details className="mt-md border-b border-border py-md group">
      <summary className="cursor-pointer text-body font-medium text-primary marker:hidden flex items-center justify-between">
        <span>{q}</span>
        <span
          aria-hidden="true"
          className="text-secondary transition-transform group-open:rotate-180"
        >
          ▾
        </span>
      </summary>
      <div className="mt-sm text-body text-secondary [&_p+p]:mt-sm [&_ol]:mt-sm">
        {a}
      </div>
    </details>
  );
}