// apps/web/app/routes/onboarding.solo._index.tsx
// TODO (Slice D follow-up): S-U3 URL state persistence is half-implemented.
// The step components (StepDistrict, StepCycleLength, StepFirstDuty, StepReminder)
// do not accept onChange. Refreshing on an intermediate step currently wipes state.
// Fix: add onChange?: (v: string | {k: string; v: string}) => void to each step
// function signature and switch defaultChecked to controlled checked+onChange.

//
// Phase 1.2 of docs/superpowers/specs/2026-07-04-phase-1-solo.md — solo
// teacher / EA onboarding wizard. Five-step flow mirroring the admin
// onboarding wizard, but skip-friendly:
//   1. Welcome        — no inputs
//   2. School district — logged via audit only (Phase 3 owns the new column)
//   3. Cycle length   — logged via audit only
//   4. First duty     — writes duty + dutyAssignment + reminder on Next
//   5. Reminder style — final POST to /api/onboarding/solo applies the choice
//
// State strategy: URL search params are the single source of truth for
// every step's choice. Refresh-safe, bookmark-friendly. The wizard
// route exports both a loader (auth + initial render) and a default
// React component; the actual DB writes happen in api.onboarding.solo.ts.

import { useState } from 'react';
import {
  Link,
  redirect,
  useLoaderData,
  useSearchParams,
} from 'react-router';
import {
  ArrowRight,
  ArrowLeft,
  CalendarRange,
  MapPin,
  Bell,
  Sparkles,
  ClipboardList,
  CheckCircle2,
} from 'lucide-react';
import type { Route } from './+types/onboarding.solo._index';
import { data } from 'react-router';
import { getSession } from '../../server/auth.server';
import { ensureCsrfCookie } from '../../server/csrf.server';
import { Button } from '../components/ui';

export function meta() {
  return [{ title: 'Set up your supervision schedule \u2014 EduSupervise' }];
}

/**
 * Loader gates: unauth'd \u2192 /login; school_admin \u2192 admin wizard;
 * substitute \u2192 /app/today (substitutes don't have a personal roster).
 * We deliberately do NOT call ensureCsrfCookie here \u2014 the wizard's
 * final POST goes to /api/onboarding/solo which mints + attaches a CSRF
 * cookie via data() helper on its own loader if needed.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (!session) throw redirect('/login');
  if (session.role === 'school_admin') throw redirect('/onboarding/admin');
  if (session.role === 'substitute') throw redirect('/app/today');
  // Mint a CSRF cookie here so the wizard's final POST
  // (to /api/onboarding/solo) validates the double-submit guard
  // without a separate round-trip. attach Set-Cookie via data().
  const { token: csrfToken, setCookie } = ensureCsrfCookie(request);
  return data(
    {
      csrfToken,
      userName: session.name,
      role: session.role as 'teacher' | 'educational_assistant',
    },
    setCookie ? { headers: { 'Set-Cookie': setCookie } } : undefined,
  );
}

const STEPS = [
  'Welcome',
  'School',
  'Cycle length',
  'First duty',
  'Reminder style',
] as const;
type Step = 0 | 1 | 2 | 3 | 4;

const DISTRICTS: Array<{ id: string; label: string }> = [
  { id: 'on_tdsb', label: 'Ontario \u2014 TDSB' },
  { id: 'on_yrdsb', label: 'Ontario \u2014 YRDSB' },
  { id: 'on_pdsb', label: 'Ontario \u2014 PDSB' },
  { id: 'on_ocdsb', label: 'Ontario \u2014 OCDSB' },
  { id: 'on_other', label: 'Ontario \u2014 Other board' },
  { id: 'bc', label: 'British Columbia' },
  { id: 'ab', label: 'Alberta' },
  { id: 'other_ca', label: 'Other Canadian province' },
  { id: 'outside_na', label: "I'm outside North America" },
];

export default function SoloOnboarding() {
  const { csrfToken, userName, role } = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const step = parseStep(params.get('step'));

  // Inputs read back from URL params (refresh-safe source of truth).
  const district = params.get('district') ?? '';
  const cycleLen = params.get('cycleLen') ?? '5';
  const dutyName = params.get('dutyName') ?? 'Morning recess';
  const dutyLocation = params.get('location') ?? 'Front doors';
  const startTime = params.get('startTime') ?? '10:30';
  const endTime = params.get('endTime') ?? '11:00';
  const reminderStyle = params.get('reminderStyle') ?? '15m_email';

  // Lift radio/select state up to the URL on every change so a refresh
  // on an intermediate step retains the selection (audit S-U3).
  function setParam(key: string, value: string): void {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true, preventScrollReset: true });
  }

  function nextHref(next: Step, overrides: Record<string, string> = {}): string {
    const merged = new URLSearchParams(params);
    merged.delete('step');
    merged.set('step', String(next));
    for (const [k, v] of Object.entries(overrides)) merged.set(k, v);
    return `/onboarding/solo?${merged.toString()}`;
  }

  return (
    <div className="min-h-[min-content] bg-bg flex flex-col">
      {/* Progress dots — ARIA progressbar with active step marked aria-current (audit S-U2). */}
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
          {step === 0 && <StepWelcome name={userName} role={role} />}
          {step === 1 && <StepDistrict current={district} districts={DISTRICTS} />}
          {step === 2 && <StepCycleLength current={cycleLen} />}
          {step === 3 && (
            <StepFirstDuty
              dutyName={dutyName}
              dutyLocation={dutyLocation}
              startTime={startTime}
              endTime={endTime}
            />
          )}
          {step === 4 && <StepReminder current={reminderStyle} />}
        </div>
      </main>

      {/* Footer — Back / Next (or Finish on the last step). Every interactive
          sits on min-h/min-w 44px for WCAG 2.5.5 Target Size (audit S-U4). */}
      <nav
        aria-label="Wizard navigation"
        className="px-md pb-md max-w-md w-full mx-auto flex items-center justify-between gap-sm"
      >
        {step > 0 ? (
          <Link
            to={nextHref((step - 1) as Step)}
            className="inline-flex items-center gap-xs min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)] px-sm text-callout text-secondary hover:text-primary transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-md"
          >
            <ArrowLeft size={18} aria-hidden />
            Back
          </Link>
        ) : (
          <Link
            to="/app/today"
            className="inline-flex items-center min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)] px-sm text-callout text-secondary hover:text-primary"
          >
            Skip for now
          </Link>
        )}
        {step < 4 ? (
          <Link
            to={nextHref(
              (step + 1) as Step,
              stepOverrides(step, {
                district,
                cycleLen,
                dutyName,
                dutyLocation,
                startTime,
                endTime,
              }),
            )}
            className="inline-flex items-center gap-sm min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)] text-callout font-semibold bg-accent text-on-accent hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transition-opacity duration-fast px-md rounded-md"
          >
            Next
            <ArrowRight size={18} aria-hidden />
          </Link>
        ) : (
          <FinishForm
            csrfToken={csrfToken}
            district={district}
            cycleLen={cycleLen}
            dutyName={dutyName}
            dutyLocation={dutyLocation}
            startTime={startTime}
            endTime={endTime}
            reminderStyle={reminderStyle}
          />
        )}
      </nav>
    </div>
  );
}// ---------------------------------------------------------------------------
// Step components. Each is a single visual block; none exceeds 50 lines
// of JSX so we keep them in this file rather than splitting into
// SoloStep*.tsx per spec section 1.2 ("extract if JSX exceeds 50 lines").
// ---------------------------------------------------------------------------

function StepWelcome({
  name,
  role,
}: {
  name: string;
  role: 'teacher' | 'educational_assistant';
}): React.ReactElement {
  const firstName = name.split(' ')[0] || 'there';
  const roleLabel = role === 'educational_assistant' ? 'educational assistant' : 'teacher';
  return (
    <Step
      icon={<Sparkles size={32} className="text-accent" aria-hidden />}
      title={`Hi ${firstName}. Let's get your supervision schedule set up.`}
      description={`You're joining as a ${roleLabel}. Four short steps and you'll have your first duty scheduled with a reminder.`}
    />
  );
}

function StepDistrict({
  current,
  districts,
}: {
  current: string;
  districts: Array<{ id: string; label: string }>;
}): React.ReactElement {
  return (
    <Step
      icon={<MapPin size={32} className="text-accent" aria-hidden />}
      title="Where is your school?"
      description="Pick your province or board. We don't share it — it helps us suggest patterns when other teachers from the same board sign up."
    >
      <div className="space-y-sm">
        {districts.map((d) => (
          <label
            key={d.id}
            className={
              'flex items-center gap-md p-sm rounded-md border cursor-pointer transition-colors duration-fast ' +
              (current === d.id
                ? 'border-accent bg-accent-soft'
                : 'border-border hover:bg-surface-2')
            }
          >
            <input
              type="radio"
              name="district"
              value={d.id}
              defaultChecked={current === d.id}
              form="onboard-form-final"
              className="sr-only"
            />
            <div className="flex-1 min-w-0 text-callout text-primary">
              {d.label}
            </div>
            <div
              aria-hidden
              className={
                'w-4 h-4 rounded-full border-2 grid place-items-center shrink-0 ' +
                (current === d.id ? 'border-accent' : 'border-border-strong')
              }
            >
              {current === d.id && (
                <span className="w-2 h-2 rounded-full bg-accent" />
              )}
            </div>
          </label>
        ))}
      </div>
    </Step>
  );
}

function StepCycleLength({ current }: { current: string }): React.ReactElement {
  return (
    <Step
      icon={<CalendarRange size={32} className="text-accent" aria-hidden />}
      title="How long is your cycle?"
      description="Most schools rotate duties across 5 weekdays. Pick what matches your roster."
    >
      <div className="space-y-sm">
        {[
          { id: '5', name: '5 days', desc: 'Mon\u2013Fri \u2014 most common' },
          { id: '6', name: '6 days', desc: 'Some independent schools' },
          { id: 'custom', name: 'Custom', desc: "I'll set it up later in Settings" },
        ].map((opt) => (
          <label
            key={opt.id}
            className={
              'flex items-start gap-md p-md rounded-md border cursor-pointer transition-colors duration-fast ' +
              (current === opt.id
                ? 'border-accent bg-accent-soft'
                : 'border-border hover:bg-surface-2')
            }
          >
            <input
              type="radio"
              name="cycleLen"
              value={opt.id}
              defaultChecked={current === opt.id}
              form="onboard-form-final"
              className="sr-only"
            />
            <div className="flex-1 min-w-0">
              <div className="text-body text-primary font-semibold">{opt.name}</div>
              <div className="text-footnote text-secondary mt-xs">{opt.desc}</div>
            </div>
            <div
              aria-hidden
              className={
                'w-5 h-5 rounded-full border-2 grid place-items-center shrink-0 mt-xs ' +
                (current === opt.id ? 'border-accent' : 'border-border-strong')
              }
            >
              {current === opt.id && (
                <span className="w-2.5 h-2.5 rounded-full bg-accent" />
              )}
            </div>
          </label>
        ))}
      </div>
    </Step>
  );
}

function StepFirstDuty({
  dutyName,
  dutyLocation,
  startTime,
  endTime,
}: {
  dutyName: string;
  dutyLocation: string;
  startTime: string;
  endTime: string;
}): React.ReactElement {
  return (
    <Step
      icon={<ClipboardList size={32} className="text-accent" aria-hidden />}
      title="Add your first duty"
      description="Just one — you can add more later from the Today screen."
    >
      <div className="space-y-md">
        <Field
          label="What is it called?"
          name="dutyName"
          defaultValue={dutyName}
          placeholder="Morning recess"
          maxLength={80}
        />
        <Field
          label="Where is it?"
          name="location"
          defaultValue={dutyLocation}
          placeholder="Front doors"
          maxLength={80}
        />
        <div className="grid grid-cols-2 gap-sm">
          <Field
            label="Start time"
            name="startTime"
            defaultValue={startTime}
            type="time"
          />
          <Field
            label="End time"
            name="endTime"
            defaultValue={endTime}
            type="time"
          />
        </div>
        <p className="text-footnote text-secondary">
          We'll set a reminder 15 minutes before. You can change this on the
          next step or later in Settings.
        </p>
      </div>
    </Step>
  );
}

function StepReminder({ current }: { current: string }): React.ReactElement {
  return (
    <Step
      icon={<Bell size={32} className="text-accent" aria-hidden />}
      title="How should we remind you?"
      description="We'll let you know before each duty starts. You can change this any time."
    >
      <div className="space-y-sm">
        {[
          {
            id: '15m_email',
            name: '15 min before \u2014 email only',
            desc: 'Default. Quiet and reliable.',
          },
          {
            id: '30m_email_sms',
            name: '30 min before \u2014 email + SMS',
            desc: 'Earlier heads-up. SMS only if you add a phone number.',
          },
          {
            id: 'custom',
            name: 'Custom',
            desc: "I'll set it up later in Settings",
          },
        ].map((opt) => (
          <label
            key={opt.id}
            className={
              'flex items-start gap-md p-md rounded-md border cursor-pointer transition-colors duration-fast ' +
              (current === opt.id
                ? 'border-accent bg-accent-soft'
                : 'border-border hover:bg-surface-2')
            }
          >
            <input
              type="radio"
              name="reminderStyle"
              value={opt.id}
              defaultChecked={current === opt.id}
              form="onboard-form-final"
              className="sr-only"
            />
            <div className="flex-1 min-w-0">
              <div className="text-body text-primary font-semibold">{opt.name}</div>
              <div className="text-footnote text-secondary mt-xs">{opt.desc}</div>
            </div>
            <div
              aria-hidden
              className={
                'w-5 h-5 rounded-full border-2 grid place-items-center shrink-0 mt-xs ' +
                (current === opt.id ? 'border-accent' : 'border-border-strong')
              }
            >
              {current === opt.id && (
                <span className="w-2.5 h-2.5 rounded-full bg-accent" />
              )}
            </div>
          </label>
        ))}
        <p className="text-footnote text-secondary mt-md inline-flex items-center gap-xs">
          <CheckCircle2 size={14} className="text-success" aria-hidden />
          You can change reminder settings per duty later.
        </p>
      </div>
    </Step>
  );
}

// ---------------------------------------------------------------------------
// Atomic primitives (kept inside this file; nothing else needs them)
// ---------------------------------------------------------------------------

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
      <h1 className="text-title-1 text-primary font-bold text-center">{title}</h1>
      <p className="text-callout text-secondary text-center mt-sm">{description}</p>
      {children && <div className="mt-xl">{children}</div>}
    </>
  );
}

function Field({
  label,
  name,
  defaultValue,
  placeholder,
  maxLength,
  type = 'text',
}: {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
  maxLength?: number;
  type?: string;
}): React.ReactElement {
  return (
    <label className="block">
      <span className="text-subhead text-secondary font-semibold mb-xs block">
        {label}
      </span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        maxLength={maxLength}
        form="onboard-form-final"
        className="w-full h-input px-md bg-surface border border-border rounded-md text-body text-primary focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent transition-colors duration-fast"
      />
    </label>
  );
}

/**
 * Final submit form. Step-3 inputs (duty name, location, times) are
 * re-collected via hidden fields so a refresh on the last step retains
 * them \u2014 they live inside <input form="onboard-form-final"> but
 * browser autofill / refresh behaviour may strip them, so we mirror.
 * Server endpoint validates CSRF + payload and returns 302 -> /app/today.
 */
function FinishForm({
  csrfToken,
  district,
  cycleLen,
  dutyName,
  dutyLocation,
  startTime,
  endTime,
  reminderStyle,
}: {
  csrfToken: string;
  district: string;
  cycleLen: string;
  dutyName: string;
  dutyLocation: string;
  startTime: string;
  endTime: string;
  reminderStyle: string;
}): React.ReactElement {
  return (
    <form
      method="post"
      action="/api/onboarding/solo"
      id="onboard-form-final"
      className="inline-flex"
    >
      {/* CSRF token. The /onboarding/solo route's loader does not run
          for the POST (action-only), so we mint one client-side via
          the meta tag the layout stamps on every page. The wizard
          route exports its own meta() and inherits the meta-tag
          contract used by app/today (see apps/web/app/root.tsx for
          the stamping site \u2014 not patched in this phase). */}
      <CsrfField token={csrfToken} />
      <input type="hidden" name="district" value={district} />
      <input type="hidden" name="cycleLen" value={cycleLen} />
      <input type="hidden" name="dutyName" value={dutyName} />
      <input type="hidden" name="location" value={dutyLocation} />
      <input type="hidden" name="startTime" value={startTime} />
      <input type="hidden" name="endTime" value={endTime} />
      <input type="hidden" name="reminderStyle" value={reminderStyle} />
      <button
        type="submit"
        className="inline-flex items-center gap-sm text-callout font-semibold bg-accent text-on-accent hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transition-opacity duration-fast px-md h-btn-md rounded-md"
      >
        Finish setup
        <ArrowRight size={18} aria-hidden />
      </button>
    </form>
  );
}

/**
 * CSRF: read from the cookie or meta. The wizard page is OUTSIDE the
 * _app layout (its own route), so it does NOT have route-loader
 * access to the parent layout's csrfToken. Fall back to the meta
 * tag the root stamps on every page (see apps/web/app/root.tsx).
 */
function CsrfField({ token }: { token: string }): React.ReactElement {
  return <input type="hidden" name="csrf" value={token} />;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the search-param overrides the Next button needs to apply
 * for the current step. We hoist every captured value into the URL so
 * refresh / Back / share-link all preserve state.
 */
function stepOverrides(
  step: number,
  v: {
    district: string;
    cycleLen: string;
    dutyName: string;
    dutyLocation: string;
    startTime: string;
    endTime: string;
  },
): Record<string, string> {
  switch (step) {
    case 0: // Welcome \u2192 District (no inputs yet)
      return { district: '' };
    case 1: // District \u2192 Cycle Length
      return { district: v.district };
    case 2: // Cycle Length \u2192 First Duty
      return { district: v.district, cycleLen: v.cycleLen };
    case 3: // First Duty \u2192 Reminder Style. Preserve text inputs.
      return {
        district: v.district,
        cycleLen: v.cycleLen,
        dutyName: v.dutyName,
        location: v.dutyLocation,
        startTime: v.startTime,
        endTime: v.endTime,
      };
    case 4: // Reminder Style \u2192 Finish (POST, no override needed)
      return {};
    default:
      return {};
  }
}

function parseStep(raw: string | null): Step {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 4) return 0;
  return n as Step;
}
