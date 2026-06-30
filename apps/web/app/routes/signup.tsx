// apps/web/app/routes/signup.tsx — public signup (3-card layout)
//
// Replaces the legacy school+first-admin form. Three cards:
//   1. Join a school — type your school's join code (WORD-NN)
//   2. I'm flying solo — create your own school, you're the admin
//   3. Try the demo — pre-seeded 30-day sandbox school
//
// All three POST to their own /api/signup/* endpoint (CSRF-protected,
// rate-limited). The card UI lives in `SignupCard`; this route is
// only the page wrapper + initial loader (which pre-mints the CSRF
// cookie so the cards have a token ready).
//
// On URL: ?school=CODE (lowercase) the Join card opens by default with
// the code pre-filled — useful when admins paste the URL into chat.

import { useSearchParams } from 'react-router';
import { Users, User, Sparkles } from 'lucide-react';
import { SignupCard } from '../components/SignupCard';
import { readCsrfCookie, mintCsrfCookie } from '../../server/csrf.server';

export function meta() {
  return [{ title: 'Sign up — EduSupervise' }];
}

export async function loader({ request }: { request: Request }) {
  // Mint a CSRF cookie if one isn't already present so the cards have
  // a token ready on the first paint.
  const existing = readCsrfCookie(request);
  if (existing) {
    return { csrfCookiePresent: true as const };
  }
  const { setCookie } = mintCsrfCookie();
  return new Response(JSON.stringify({ csrfCookiePresent: false as const }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'Set-Cookie': setCookie,
    },
  });
}

export default function SignupPage() {
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
        className="w-full h-input px-md bg-surface border border-border rounded-md text-body text-primary uppercase tracking-wide font-mono focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent transition-colors duration-fast"
      />
    </label>
  );
}