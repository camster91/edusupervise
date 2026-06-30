// apps/web/app/components/SignupCard.tsx
//
// One of the three signup cards on the /signup page. Each card has:
//   - Icon + title + one-line description (always visible)
//   - Inline form that expands when the card is clicked
//   - Submit button + error display
//
// The mode-specific field is rendered by the `modeSpecific` slot.

import { useState } from 'react';
import { Form, useNavigation } from 'react-router';
import { useCsrfToken } from '~/lib/csrf';
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
}

export function SignupCard(props: SignupCardProps): React.ReactElement {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const csrfToken = useCsrfToken();
  const nav = useNavigation();
  const submitting = nav.state !== 'idle' && nav.formAction === props.action;
  const error = (nav.data as { error?: string } | undefined)?.error;

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
            <PasswordField />

            {props.modeSpecific}

            {error && (
              <p
                role="alert"
                className="text-callout text-danger rounded-md bg-danger-soft px-md py-sm"
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
}): React.ReactElement {
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
        className={
          'w-full h-input px-md bg-surface border border-border rounded-md text-body text-primary ' +
          'focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent transition-colors duration-fast ' +
          (props.uppercase ? 'uppercase tracking-wide font-mono' : '')
        }
      />
    </label>
  );
}

function PasswordField(): React.ReactElement {
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
          className="w-full h-input px-md pr-20 bg-surface border border-border rounded-md text-body text-primary focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent transition-colors duration-fast"
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-callout text-secondary hover:text-primary px-sm py-xs rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
    </label>
  );
}