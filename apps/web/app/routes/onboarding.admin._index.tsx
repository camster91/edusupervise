// apps/web/app/routes/onboarding.admin._index.tsx — Admin wizard (HIG spec,
// design system section 3.4).
//
// 3-4 card SMS-style flow:
//   1. Welcome + school name
//   2. Add your teachers
//   3. Choose a duty template
//   4. You're all set
//
// Each card is full-screen on iPhone, modal on iPad. "Next" bottom-right.
// Back is hidden in steps 1 and 4 (commit points).

import { useState } from 'react';
import { redirect, useNavigate, Link } from 'react-router';
import { ArrowRight, ArrowLeft, Users, ClipboardList, Sparkles, School } from 'lucide-react';
import type { Route } from './+types/onboarding.admin._index';
import { getSession } from '../server/auth.server';
import { Button } from '../components/ui';

export function meta() {
  return [{ title: 'Set up your school — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (!session) throw redirect('/login');
  return { schoolName: 'Your school' };
}

type Step = 0 | 1 | 2 | 3;
const STEPS = ['Welcome', 'Add teachers', 'Duty template', 'You\'re set'] as const;

export default function AdminOnboarding() {
  const { schoolName } = useLoaderData<typeof loader>();
  const [step, setStep] = useState<Step>(0);
  const [name, setName] = useState(schoolName);
  const [teacherCount, setTeacherCount] = useState(0);
  const [template, setTemplate] = useState<string>('elementary');
  const navigate = useNavigate();

  const next = () => setStep((s) => Math.min(3, (s + 1) as Step));
  const back = () => setStep((s) => Math.max(0, (s - 1) as Step));
  const done = () => navigate('/app/today');

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      {/* Progress dots */}
      <div className="px-md pt-md flex items-center justify-center gap-xs">
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
            aria-label={`Step ${i + 1} of ${STEPS.length}: ${label}`}
          />
        ))}
      </div>

      <div className="flex-1 flex items-center justify-center p-md">
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
              icon={<Users size={32} className="text-accent" aria-hidden />}
              title="Add your teachers"
              description="You can add them now or import a CSV later from Settings."
            >
              <div>
                <label className="block">
                  <span className="text-subhead text-secondary font-semibold mb-xs block">
                    How many teachers does your school have?
                  </span>
                  <input
                    type="number"
                    min="0"
                    value={teacherCount}
                    onChange={(e) => setTeacherCount(Number(e.target.value))}
                    className="w-full h-input px-md bg-surface border border-border rounded-md text-body text-primary focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent transition-colors duration-fast tabular"
                  />
                </label>
                <p className="text-footnote text-secondary mt-sm">
                  We'll create placeholder accounts you can edit in the next step.
                </p>
              </div>
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
                <strong>Tip:</strong> Import your teacher roster from CSV in Settings →
                Roster to skip manual entry.
              </div>
            </Step>
          )}
        </div>
      </div>

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
