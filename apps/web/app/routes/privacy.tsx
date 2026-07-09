// apps/web/app/routes/privacy.tsx — public privacy policy page.
//
// Publicly accessible (no auth) so the App Store Connect "Privacy
// Policy URL" can resolve to it during submission. Apple requires
// the URL to return real content — not a 404, not a login wall, not
// a 5-line stub. This file is what reviewers will see.
//
// Conventions:
//   - Plain English, 12th-grade reading level. Cameron has asked for
//     this style across all user-facing copy.
//   - Specific data retention periods (not "may retain indefinitely").
//   - Names the third-party services that touch the data — Apple's
//     privacy questionnaire asks for this directly.
//   - Effective date + last-updated stamp at the top so reviewers can
//     tell the policy is current.

import { Link } from 'react-router';
import type { Route } from './+types/privacy';

export function meta() {
  return [
    { title: 'Privacy Policy — EduSupervise' },
    {
      name: 'description',
      content:
        'What data EduSupervise collects, why, where it is stored, and what rights you have. Plain English, current as of the date below.',
    },
  ];
}

const EFFECTIVE_DATE = 'July 9, 2026';
const CONTACT_EMAIL = 'privacy@edusupervise.ashbi.ca';

export async function loader() {
  return {
    effectiveDate: EFFECTIVE_DATE,
    contactEmail: CONTACT_EMAIL,
  };
}

export default function PrivacyPolicy({ loaderData }: Route.ComponentProps) {
  const { effectiveDate, contactEmail } = loaderData;
  return (
    <main
      id="main"
      className="min-h-screen bg-bg text-primary"
    >
      <article className="mx-auto max-w-3xl px-md py-2xl">
        <Link
          to="/"
          className="text-sm text-accent hover:underline"
        >
          ← Back to EduSupervise
        </Link>

        <header className="mt-lg mb-2xl">
          <h1 className="text-display font-bold tracking-tight">Privacy Policy</h1>
          <p className="mt-sm text-callout text-secondary">
            Effective {effectiveDate}. Plain English. If you want the legal
            version with defined terms and jurisdiction clauses, email{' '}
            <a className="text-accent hover:underline" href={`mailto:${contactEmail}`}>
              {contactEmail}
            </a>
            .
          </p>
        </header>

        <Section title="What we collect">
          <p>
            EduSupervise is a duty-scheduling app for K-12 schools. We
            collect what we need to do that job and nothing else.
          </p>
          <ul className="mt-md list-disc space-y-xs pl-lg">
            <li>
              <strong>Email</strong> — your login, your reminder delivery
              channel.
            </li>
            <li>
              <strong>Name</strong> — your display name on the duty roster
              and in coverage broadcasts.
            </li>
            <li>
              <strong>Phone</strong> — only if you opt in to SMS reminders.
              Most users don't.
            </li>
            <li>
              <strong>School name + identifier</strong> — to keep your
              school's data separate from other schools' (multi-tenant
              isolation).
            </li>
            <li>
              <strong>Duty schedule data</strong> — who covers what
              shift, when, and where.
            </li>
            <li>
              <strong>Notification log</strong> — which reminders fired,
              when, and whether they were delivered. This is for the
              app, not for advertisers.
            </li>
          </ul>
        </Section>

        <Section title="What we DON'T collect">
          <ul className="list-disc space-y-xs pl-lg">
            <li>No advertising IDs. No third-party trackers. No Facebook Pixel.</li>
            <li>
              No location data. We don't track where you are. (The duty
              location is a school room number, set by the admin — not
              your GPS.)
            </li>
            <li>
              No student or child data. EduSupervise is for staff
              scheduling only. The students you supervise are referenced
              by class name (set by the admin), never tracked as
              individual records.
            </li>
          </ul>
        </Section>

        <Section title="Where your data is stored">
          <p>
            Your school's data lives in a private Postgres database hosted
            on our VPS (Ashbi Inc., Toronto). The database is encrypted at
            rest. Backups are encrypted with the same standard (AES-256)
            and stored off-host.
          </p>
          <p className="mt-md">
            Each school is a separate tenant. Your school's data is not
            visible to other schools, your school's admins, or anyone
            outside your school. We use Postgres row-level security to
            enforce this at the database level — there is no application
            code path that can read across tenants.
          </p>
        </Section>

        <Section title="Third-party services">
          <p>
            EduSupervise uses a small number of third-party services to
            deliver the product. Each one receives only the data it needs
            to do its job.
          </p>
          <ul className="mt-md list-disc space-y-xs pl-lg">
            <li>
              <strong>Mailgun</strong> (email delivery) — receives your
              email and the message body. Sends transactional email
              (reminders, coverage alerts, account notifications).
            </li>
            <li>
              <strong>Stripe</strong> (web billing only) — receives billing
              details for paid plans. <em>Stripe is NOT used inside the
              iOS app</em> — the iOS build is read-only, and all
              subscription management happens in Safari on the web.
            </li>
            <li>
              <strong>Apple Push Notification service (APNs)</strong> —
              receives a device token from the iOS app and the
              notification payload. Apple's privacy policy governs that
              data.
            </li>
            <li>
              <strong>Mozilla / browser push services</strong> (Web Push
              only) — receives a per-browser subscription endpoint
              and a public VAPID key. The notification payload is
              encrypted so the push service cannot read it.
            </li>
          </ul>
        </Section>

        <Section title="Data retention">
          <p>
            We keep your data for as long as your school is active. When
            you delete your school (admins can do this in
            Settings → School → Delete), we delete the school record and
            cascade-delete everything tied to it within 30 days.
          </p>
          <p className="mt-md">
            Audit logs (who did what, when) are retained for{' '}
            <strong>30 days on the free plan, 90 days on paid plans</strong>.
            We retain them for debugging, not for compliance surveillance.
          </p>
        </Section>

        <Section title="Your rights">
          <ul className="list-disc space-y-xs pl-lg">
            <li>
              <strong>Export</strong> — your school admin can download a
              JSON export of the entire school dataset from Settings.
            </li>
            <li>
              <strong>Delete</strong> — your school admin can delete the
              school (and all data) from Settings. Individual users can
              request account deletion by emailing{' '}
              <a className="text-accent hover:underline" href={`mailto:${contactEmail}`}>
                {contactEmail}
              </a>
              .
            </li>
            <li>
              <strong>Correct</strong> — change your name, email, or
              phone at any time from your profile page.
            </li>
            <li>
              <strong>Opt out of analytics</strong> — there is no
              analytics in the current release. When we add it (Tier 2),
              there will be an opt-out toggle in Settings.
            </li>
          </ul>
        </Section>

        <Section title="Children's data">
          <p>
            EduSupervise is a staff tool. We do not knowingly collect
            personal data from anyone under 18. School admins who
            reference students by name are responsible for compliance
            with their district's student data policies; we provide the
            tool, not the policy.
          </p>
        </Section>

        <Section title="Changes to this policy">
          <p>
            We will email all school admins at least 30 days before any
            material change takes effect. The "Effective" date at the
            top of this page is the source of truth — refresh it from
            time to time.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Questions, complaints, or formal privacy requests:{' '}
            <a
              className="text-accent hover:underline"
              href={`mailto:${contactEmail}`}
            >
              {contactEmail}
            </a>
            . We respond within 5 business days.
          </p>
        </Section>

        <footer className="mt-3xl border-t border-border pt-xl text-callout text-secondary">
          <p>
            Ashbi Inc. · Toronto, Canada · {effectiveDate}
          </p>
        </footer>
      </article>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-2xl">
      <h2 className="text-title-2 font-semibold tracking-tight text-primary">
        {title}
      </h2>
      <div className="mt-md text-body text-primary [&_p+p]:mt-sm [&_ul]:mt-md">
        {children}
      </div>
    </section>
  );
}