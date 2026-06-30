// apps/web/app/routes/signup.tsx — public signup (3-card layout)
//
// Replaces the legacy school+first-admin form. Three cards:
//   1. Join a school — type your school's join code (WORD-NN)
//   2. I'm flying solo — create your own school, you're the admin
//   3. Try the demo — pre-seeded 30-day sandbox school
//
// All three POST to their own /api/signup/* endpoint (CSRF-protected,
// rate-limited). The card UI lives in `SignupCard`; this route is
// only the page wrapper.
//
// CSRF cookie mint+read (verifier finding, 2026-06-30):
//   The previous version of this loader just read the cookie from
//   request.headers.cookie and returned it. But on the FIRST visit,
//   the cookie wasn't in the request (entry.server.tsx was queuing
//   it for the response), so the loader returned csrfToken="" and
//   the form was rendered with an empty hidden field. Even after
//   the browser stored the cookie, the verifier observed that the
//   form still rendered with value="" because RR7's .data request
//   (which re-fetches loader data after a click) hit a route where
//   the cookie lookup raced with the cookie mint.
//
//   The correct fix is to mint the cookie IN THIS LOADER when
//   missing, attach the Set-Cookie header to the response, and
//   return the freshly-minted token in loader data. This guarantees
//   the cookie is set on the browser AND the loader data has the
//   token, in the same response.
//
// On URL: ?school=CODE (lowercase) the Join card opens by default with
// the code pre-filled — useful when admins paste the URL into chat.

import { useLoaderData, useSearchParams } from 'react-router';
import { Users, User, Sparkles } from 'lucide-react';
import { SignupCard } from '../components/SignupCard';
import { mintCsrfCookie, readCsrfCookie } from '../../server/csrf.server';

export function meta() {
  return [{ title: 'Sign up — EduSupervise' }];
}

/**
 * Loader returns the CSRF token to use in form bodies, minting one
 * (and attaching Set-Cookie) if the request doesn't already carry
 * the cookie. This is the source of truth for the CSRF token —
 * entry.server.tsx no longer mints it (avoids duplicate Set-Cookie).
 */
export function loader({ request }: { request: Request }) {
  const existing = readCsrfCookie(request);
  if (existing) {
    return { csrfToken: existing };
  }
  // No cookie yet — mint and set on the response so the browser
  // gets the cookie AND we return the token to populate the form.
  const { token, setCookie } = mintCsrfCookie();
  return new Response(JSON.stringify({ csrfToken: token }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': setCookie,
    },
  });
}

export default function SignupPage() {
  const { csrfToken } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const presetCode = params.get('school')?.toUpperCase().trim() ?? '';

  return (
    <main className="min-h-screen bg-bg px-md py-2xl">
      <div className="max-w-2xl mx-auto">
        <header className="text-center mb-2xl">
          <h1 className="text-display text-primary font-bold">
            Get started with EduSupervise
          </h1>
          <p className="text-callout text-secondary mt-sm max-w-md mx-auto">
            Coverage for absent teachers. Targeted parent alerts when duties shift.
            No credit card required.
          </p>
        </header>

        <div className="space-y-md">
          <SignupCard
            id="join"
            csrfToken={csrfToken}
            icon={<Users size={22} className="text-accent" aria-hidden />}
            title="Join a school"
            description="Enter the join code your admin shared with you. You'll join as a teacher."
            action="/api/signup/join"
            submitLabel="Join my school"
            defaultOpen={presetCode.length > 0}
            hiddenFields={
              presetCode ? { schoolCode: presetCode } : undefined
            }
            modeSpecific={<JoinSchoolFields presetCode={presetCode} />}
          />

          <SignupCard
            id="solo"
            csrfToken={csrfToken}
            icon={<User size={22} className="text-accent" aria-hidden />}
            title="I'm flying solo"
            description="Create a school for just yourself. You're the admin, so you can manage duties and billing."
            action="/api/signup/solo"
            submitLabel="Create my school"
            modeSpecific={
              <label className="block">
                <span className="text-subhead text-secondary font-semibold mb-xs block">
                  School name
                </span>
                <input
                  name="schoolName"
                  type="text"
                  required
                  minLength={2}
                  maxLength={80}
                  placeholder="e.g. Maple Elementary"
                  className="w-full h-input px-md bg-surface border border-border rounded-md text-body text-primary focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent transition-colors duration-fast"
                />
              </label>
            }
          />

          <SignupCard
            id="demo"
            csrfToken={csrfToken}
            icon={<Sparkles size={22} className="text-accent" aria-hidden />}
            title="Try the demo"
            description="Pre-seeded sample school with 5 teachers, 4 duties, and a live coverage scenario. Resets in 30 days."
            action="/api/signup/demo"
            submitLabel="Start the demo"
          />
        </div>

        <footer className="text-center mt-2xl">
          <p className="text-callout text-secondary">
            Already have an account?{' '}
            <a href="/login" className="text-accent font-semibold hover:underline">
              Sign in
            </a>
          </p>
        </footer>
      </div>
    </main>
  );
}

function JoinSchoolFields({ presetCode }: { presetCode: string }): React.ReactElement {
  return (
    <label className="block">
      <span className="text-subhead text-secondary font-semibold mb-xs block">
        School join code
        <span className="text-secondary font-normal text-footnote ml-xs">
          (e.g. SUNRISE-43)
        </span>
      </span>
      <input
        name="schoolCode"
        type="text"
        required
        defaultValue={presetCode}
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        placeholder="SUNRISE-43"
        pattern="[A-Za-z0-9-]{4,12}"
        className="w-full h-input px-md bg-surface border border-border rounded-md text-body text-primary focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent transition-colors duration-fast"
      />
    </label>
  );
}