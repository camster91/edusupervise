// apps/web/app/routes/onboarding.admin._index.tsx — Admin wizard (HIG spec,
// design system section 3.4).
//
// 4-card SMS-style flow:
//   1. Welcome + school name
//   2. Share your join code  (replaces the broken "Add teachers" step
//      that asked for a count but did nothing — see migration 0006)
//   3. Choose a duty template
//   4. You're all set
//
// Each card is full-screen on iPhone, modal on iPad. "Next" bottom-right.
// Back is hidden in steps 1 and 4 (commit points).

import { useState } from 'react';
import { redirect, useLoaderData, useNavigate, Link } from 'react-router';
import { eq } from 'drizzle-orm';
import { ArrowRight, ArrowLeft, ClipboardList, Sparkles, School, Copy, Check } from 'lucide-react';
import type { Route } from './+types/onboarding.admin._index';
import { schools } from '@edusupervise/db';
import { getSession } from '../../server/auth.server';
import { withSchoolId } from '../../server/db.server';
import { Button } from '../components/ui';

export function meta() {
  return [{ title: 'Set up your school — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (!session) throw redirect('/login');
  return withSchoolId(session.schoolId, async (tx) => {
    const [school] = await tx
      .select({
        id: schools.id,
        name: schools.name,
        joinCode: schools.joinCode,
      })
      .from(schools)
      .where(eq(schools.id, session.schoolId))
      .limit(1);
    return {
      schoolName: school?.name ?? 'Your school',
      joinCode: school?.joinCode ?? null,
    };
  });
}

type Step = 0 | 1 | 2 | 3;
const STEPS = ['Welcome', 'Share code', 'Duty template', 'You\'re set'] as const;

export default function AdminOnboarding() {
  const { schoolName, joinCode } = useLoaderData<typeof loader>();
  const [step, setStep] = useState<Step>(0);
  const [name, setName] = useState(schoolName);
  const [template, setTemplate] = useState<string>('elementary');
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();

  const next = () => setStep((s) => Math.min(3, s + 1) as Step);
  const back = () => setStep((s) => Math.max(0, s - 1) as Step);
  const done = () => navigate('/app/today');

  async function copyCode() {
    if (!joinCode) return;
    try {
      await navigator.clipboard.writeText(joinCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // no-op fallback
    }
  }

  return (
    <div className="min-h-[min-content] bg-bg flex flex-col">
      {/* Progress dots \u2014 ARIA progressbar with active step aria-current (audit S-U2).
          S-U5: outer div caps at min-h-[min-content] so the card isn't floating in
          the middle of a 1080p desktop screen. */}
      <div
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={STEPS.length}
        aria-valuenow={step + 1}
        aria-valuetext={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}
        className="px-md pt-md flex items-center justify-center gap-xs"
      >
        {STEPS.map((label, i) => (
          <div
            key={label}
            className={
              'h-1.5 rounded-full transition-all duration-base ' +
              (i === step
                ? 'w-8 bg-accent'
                : i < step
                  ? 'w-1.5 bg-accent'
                  : 'w-1.5 bg-divider')
            }
            aria-current={i === step ? 'step' : undefined}
            aria-label={i === step ? `Step ${i + 1} of ${STEPS.length}: ${label} (current)` : undefined}
          />
        ))}
      </div>

      <main id="main" className="flex-1 flex items-center justify-center p-md">
        <div className="max-w-md w-full bg-surface rounded-xl border border-border shadow-elev-1 p-2xl">
          {step === 0 && (
            <Step
              icon={<School size={32} className="text-accent" aria-hidden />}
              title="Welcome to EduSupervise"
              description="Let's set up your school in 3 quick steps."
            >
              <label className="block">
                <span className="text-subhead text-secondary font-semibold mb-xs block">
                  School name
                </span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full h-input px-md bg-surface border border-border rounded-md text-body text-primary focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent transition-colors duration-fast"
                />
              </label>
            </Step>
          )}

          {step === 1 && (
            <Step
              icon={<School size={32} className="text-accent" aria-hidden />}
              title="Share your join code"
              description="Teachers sign themselves up at /signup with this code."
            >
              {joinCode ? (
                <div>
                  <code className="block w-full text-title-2 text-primary font-mono font-semibold tracking-wide bg-bg border border-border rounded-md px-md py-sm text-center select-all">
                    {joinCode}
                  </code>
                  <button
                    type="button"
                    onClick={copyCode}
                    className="mt-md w-full h-btn-md rounded-md font-semibold bg-accent text-on-accent hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transition-colors duration-fast inline-flex items-center justify-center gap-sm"
                  >
                    {copied ? <Check size={18} aria-hidden /> : <Copy size={18} aria-hidden />}
                    {copied ? 'Copied' : 'Copy code'}
                  </button>
                  <p className="text-footnote text-secondary mt-md">
                    Anyone with this code can join your school. Don't share it publicly.
                    You can rename it later in Settings.
                  </p>
                </div>
              ) : (
                <p className="text-callout text-secondary">Loading join code…</p>
              )}
            </Step>
          )}

          {step === 2 && (
            <Step
              icon={<ClipboardList size={32} className="text-accent" aria-hidden />}
              title="Choose a duty template"
              description="A starting set of duty slots you can customize later."
            >
              <div className="space-y-sm">
                {[
                  { id: 'elementary', name: 'Elementary standard', desc: 'Lunch, recess, dismissal — 4-6 rotations' },
                  { id: 'middle', name: 'Middle school 6-period', desc: 'Hallway, cafeteria, after-school — 8 rotations' },
                  { id: 'high', name: 'High school 8-period', desc: 'Bus, parking, cafeteria, detention — 12 rotations' },
                  { id: 'blank', name: 'Start blank', desc: 'I\'ll set up my own duties' },
                ].map((t) => (
                  <label
                    key={t.id}
                    className={
                      'flex items-start gap-md p-md rounded-md border cursor-pointer transition-colors duration-fast ' +
                      (template === t.id
                        ? 'border-accent bg-accent-soft'
                        : 'border-border hover:bg-surface-2')
                    }
                  >
                    <input
                      type="radio"
                      name="template"
                      value={t.id}
                      checked={template === t.id}
                      onChange={(e) => setTemplate(e.target.value)}
                      className="sr-only"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-body text-primary font-semibold">
                        {t.name}
                      </div>
                      <div className="text-footnote text-secondary mt-xs">
                        {t.desc}
                      </div>
                    </div>
                    <div
                      aria-hidden
                      className={
                        'w-5 h-5 rounded-full border-2 grid place-items-center shrink-0 mt-xs ' +
                        (template === t.id
                          ? 'border-accent'
                          : 'border-border-strong')
                      }
                    >
                      {template === t.id && (
                        <span className="w-2.5 h-2.5 rounded-full bg-accent" />
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </Step>
          )}

          {step === 3 && (
            <Step
              icon={<Sparkles size={32} className="text-success" aria-hidden />}
              title={`You're all set, ${name}.`}
              description="Your school is ready. We'll take you to your dashboard now."
            >
              <div className="bg-success-soft text-success rounded-md p-md text-callout">
                <strong>Tip:</strong> Share your join code with your teachers so
                they can sign up at <code>/signup</code>. You can always find it
                again in Settings → School.
              </div>
              <div className="mt-md bg-bg border border-border rounded-md p-md text-callout">
                <strong>Not running this for your whole school?</strong>{' '}
                If you only need to track your own supervision duties, the
                solo teacher path is faster — no school setup, no admin role.
                {' '}
                <a href="/signup?mode=solo" className="text-accent font-semibold hover:underline">
                  Try solo instead →
                </a>
              </div>
            </Step>
          )}
        </div>
      </main>

      {/* Footer */}
      <div className="px-md pb-md max-w-md w-full mx-auto flex items-center justify-between">
        {step > 0 ? (
          <Button variant="tertiary" size="md" onClick={back}>
            <ArrowLeft size={18} aria-hidden />
            Back
          </Button>
        ) : (
          <Link to="/login" className="text-callout text-secondary hover:text-primary">
            Sign in instead
          </Link>
        )}
        {step < 3 ? (
          <Button variant="primary" size="md" onClick={next}>
            {step === 2 ? 'Continue' : 'Next'}
            <ArrowRight size={18} aria-hidden />
          </Button>
        ) : (
          <Button variant="primary" size="md" onClick={done}>
            Open my dashboard
            <ArrowRight size={18} aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );
}

function Step({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <>
      <div
        aria-hidden
        className="mx-auto w-16 h-16 rounded-full bg-accent-soft grid place-items-center mb-xl"
      >
        {icon}
      </div>
      <h1 className="text-title-1 text-primary font-bold text-center">
        {title}
      </h1>
      <p className="text-callout text-secondary text-center mt-sm">
        {description}
      </p>
      {children && <div className="mt-xl">{children}</div>}
    </>
  );
}
