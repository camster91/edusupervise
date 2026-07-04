// apps/web/app/components/SignupCard.tsx
//
// One of the three signup cards on the /signup page. Each card has:
//   - Icon + title + one-line description (always visible)
//   - Inline form that expands when the card is clicked
//   - Submit button + error display
//
// The mode-specific field is rendered by the `modeSpecific` slot.

import { useState } from 'react';
import { Form, useActionData, useNavigation } from 'react-router';
import { ChevronDown } from 'lucide-react';

export interface SignupCardProps {
  id: 'join' | 'solo' | 'demo';
  icon: React.ReactNode;
  title: string;
  description: string;
  action: string;             // POST endpoint
  submitLabel: string;        // "Join", "Create my school", "Start demo"
  modeSpecific?: React.ReactNode;
  /** When true, the card is open by default (used for ?school=CODE preselect). */
  defaultOpen?: boolean;
  /** Hidden field set when the card is open (e.g. pre-filled schoolCode). */
  hiddenFields?: Record<string, string>;
  /**
   * CSRF token to write into the hidden form field. MUST be supplied
   * by the caller — read it server-side from the request cookie and
   * pass it down. We can't read it from `document.cookie` because
   * Chromium treats the `__Host-` cookie prefix as HttpOnly even
   * when the Set-Cookie header says otherwise (verifier finding,
   * 2026-06-30).
   */
  csrfToken: string;
}

export function SignupCard(props: SignupCardProps): React.ReactElement {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const csrfToken = props.csrfToken;
  const nav = useNavigation();
  // useActionData picks up the response body from /api/signup/{join,solo,demo}
  // even though that route is separate from this /signup page. RR7's Form
  // navigates to the action's response, and useActionData reflects the data
  // returned. We filter by formAction so the card only shows errors from
  // its OWN submit (not from the other two cards on the same page).
  const actionData = useActionData() as { error?: string } | undefined;
  const submitting = nav.state !== 'idle' && nav.formAction === props.action;
  // Show the error either from the in-flight nav (when the response is still
  // pending display) or from the most recent settled action for this formAction.
  const navError =
    nav.formAction === props.action && 'data' in nav
      ? ((nav.data as { error?: string } | undefined)?.error)
      : undefined;
  const error = navError ?? actionData?.error;

  return (
    <div
      className={
        'rounded-2xl border transition-colors duration-base ' +
        (open
          ? 'border-accent bg-accent-soft/40 shadow-elev-2'
          : 'border-border bg-surface hover:border-border-strong shadow-elev-1')
      }
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`signup-card-${props.id}-body`}
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left px-xl py-lg flex items-start gap-md"
      >
        <div
          aria-hidden
          className="shrink-0 w-12 h-12 rounded-full bg-accent-soft grid place-items-center"
        >
          {props.icon}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-title-3 text-primary font-semibold">
            {props.title}
          </h2>
          <p className="text-callout text-secondary mt-xs">
            {props.description}
          </p>
        </div>
        <ChevronDown
          size={20}
          className={
            'text-secondary shrink-0 mt-1 transition-transform duration-base ' +
            (open ? 'rotate-180' : '')
          }
          aria-hidden
        />
      </button>

      {open && (
        <div
          id={`signup-card-${props.id}-body`}
          className="px-xl pb-xl pt-xs"
        >
          <Form method="post" action={props.action} className="space-y-md">
            <input type="hidden" name="csrf" value={csrfToken} />
            {props.hiddenFields &&
              Object.entries(props.hiddenFields).map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={v} />
              ))}

            <Field
              name="name"
              label="Your name"
              autoComplete="name"
              required
              minLength={1}
              maxLength={80}
            />
            <Field
              name="email"
              type="email"
              label="Email"
              autoComplete="email"
              required
            />
            <PasswordField error={inlineError?.field === 'password' ? inlineError.message : undefined} />

            {props.id === 'solo' && (
              <fieldset>
                <legend className="block text-subhead text-secondary font-semibold mb-xs">
                  I'm signing up as a
                </legend>
                <div className="space-y-xs">
                  {[
                    {
                      id: 'teacher',
                      name: 'Teacher',
                      desc: 'Run your own supervision schedule',
                    },
                    {
                      id: 'educational_assistant',
                      name: 'Educational assistant',
                      desc: "Cover specific slots in someone else's rotation",
                    },
                    {
                      id: 'school_admin',
                      name: 'School admin',
                      desc: 'Set up duties for the whole school',
                    },
                  ].map((r) => (
                    <label
                      key={r.id}
                      className={
                        'flex items-start gap-sm p-sm rounded-md border cursor-pointer transition-colors duration-fast ' +
                        (r.id === 'teacher'
                          ? 'border-accent bg-accent-soft'
                          : 'border-border hover:bg-surface-2')
                      }
                    >
                      <input
                        type="radio"
                        name="role"
                        value={r.id}
                        defaultChecked={r.id === 'teacher'}
                        className="sr-only"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-callout text-primary font-semibold">
                          {r.name}
                        </div>
                        <div className="text-footnote text-secondary mt-xs">
                          {r.desc}
                        </div>
                      </div>
                      <div
                        aria-hidden
                        className={
                          'w-4 h-4 rounded-full border-2 grid place-items-center shrink-0 mt-xs ' +
                          (r.id === 'teacher'
                            ? 'border-accent'
                            : 'border-border-strong')
                        }
                      >
                        {r.id === 'teacher' && (
                          <span className="w-2 h-2 rounded-full bg-accent" />
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {props.modeSpecific}

            {error && (
              <p
                role="alert"
                className="text-callout text-error rounded-md bg-error-soft px-md py-sm"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full h-btn-md rounded-md font-semibold bg-accent text-on-accent hover:opacity-90 disabled:opacity-60 transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            >
              {submitting ? 'Working…' : props.submitLabel}
            </button>
          </Form>
        </div>
      )}
    </div>
  );
}

function Field(props: {
  name: string;
  label: string;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  placeholder?: string;
  uppercase?: boolean;
  error?: string;
}): React.ReactElement {
  const errorId = props.error ? `${props.name}-error` : undefined;
  return (
    <label className="block">
      <span className="text-subhead text-secondary font-semibold mb-xs block">
        {props.label}
      </span>
      <input
        name={props.name}
        type={props.type ?? 'text'}
        autoComplete={props.autoComplete}
        required={props.required}
        minLength={props.minLength}
        maxLength={props.maxLength}
        placeholder={props.placeholder}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={errorId}
        className={
          'w-full h-input px-md bg-surface border rounded-md text-body text-primary ' +
          'focus:outline-none focus:ring-2 focus:ring-accent transition-colors duration-fast ' +
          (props.error ? 'border-error' : 'border-border focus:border-accent ') +
          (props.uppercase ? 'uppercase tracking-wide font-mono' : '')
        }
      />
      {props.error && (
        <p id={errorId} role="alert" className="mt-xs text-callout text-error">
          {props.error}
        </p>
      )}
    </label>
  );
}

function PasswordField({ error }: { error?: string }): React.ReactElement {
  const [show, setShow] = useState(false);
  return (
    <label className="block">
      <span className="text-subhead text-secondary font-semibold mb-xs block">
        Password
        <span className="text-secondary font-normal text-footnote ml-xs">
          (min 8 chars)
        </span>
      </span>
      <div className="relative">
        <input
          name="password"
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={128}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'password-error' : undefined}
          className={
            'w-full h-input px-md pr-20 bg-surface border rounded-md text-body text-primary focus:outline-none focus:ring-2 focus:ring-accent transition-colors duration-fast ' +
            (error ? 'border-error' : 'border-border focus:border-accent')
          }
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? 'Hide password' : 'Show password'}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-callout text-secondary hover:text-primary px-sm py-xs rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
      {error && (
        <p id="password-error" role="alert" className="mt-xs text-callout text-error">
          {error}
        </p>
      )}
    </label>
  );
}


/**
 * Heuristic keyword match for server error strings. The signup API
 * returns `{ error: 'human string' }` with no structured code, so
 * we sniff the message for the field it most likely refers to. If
 * nothing matches, returns null and the caller falls back to the
 * bottom-of-form summary.
 *
 * Keep the keywords tight — false positives (highlighting the wrong
 * field) are worse than false negatives (fall back to summary).
 */
function fieldForError(message: string): { field: string; message: string } | null {
  const lower = message.toLowerCase();
  if (lower.includes('email') && (lower.includes('already') || lower.includes('exists') || lower.includes('invalid'))) {
    return { field: 'email', message };
  }
  if (lower.includes('password') && (lower.includes('short') || lower.includes('chars') || lower.includes('weak') || lower.includes('invalid'))) {
    return { field: 'password', message };
  }
  if (lower.includes('name') && (lower.includes('required') || lower.includes('enter') || lower.includes('invalid'))) {
    return { field: 'name', message };
  }
  if (lower.includes('school') && (lower.includes('not found') || lower.includes('invalid') || lower.includes('join code') || lower.includes('code'))) {
    return { field: 'schoolCode', message };
  }
  return null;
}
