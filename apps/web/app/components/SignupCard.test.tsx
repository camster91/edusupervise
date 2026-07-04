// apps/web/app/components/SignupCard.test.tsx — regression tests for
// the error-class swap (audit B8, 2026-07-04 — signup errors were
// invisible because the CSS used `text-danger` + `bg-danger-soft`,
// but the design system defines `text-error` + `bg-error-soft`).
//
// What's being guarded:
//   - The error <p> renders with class `text-error` (NOT
//     `text-danger`).
//   - The error <p> renders with class `bg-error-soft` (NOT
//     `bg-danger-soft`).
//   - The error <p> has role="alert" so screen readers announce it.
//
// We render via ReactDOMServer.renderToStaticMarkup — no DOM needed.
// The action data is faked via useActionData / useNavigation mocks.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

// Mock react-router. SignupCard reads:
//   - useNavigation() for submitting state
//   - useActionData() for the action's response shape
//   - Form() for the action submit
//
// We control the action data per test by reassigning the mock
// return value (vi.mock factories are hoisted, so we use a mutable
// holder the mock closure reads).
const holder: {
  actionData: { error?: string } | undefined;
  navState: 'idle' | 'submitting';
  formAction: string | undefined;
} = {
  actionData: { error: 'Invalid invite code. Please check the link your admin sent.' },
  navState: 'idle',
  formAction: '/api/signup/join',
};

vi.mock('react-router', () => ({
  useNavigation: () => ({
    state: holder.navState,
    formAction: holder.formAction,
  }),
  useActionData: () => holder.actionData,
  Form: ({ children }: { children?: React.ReactNode }) => createElement('form', null, children),
}));

const { SignupCard } = await import('./SignupCard.js');

describe('SignupCard error styling (B8 regression guard)', () => {
  it('renders the error <p> with class "text-error" (NOT "text-danger")', () => {
    const html = renderToStaticMarkup(
      createElement(SignupCard, {
        id: 'join',
        icon: null,
        title: 'Join your school',
        description: 'Use the 6-character join code your admin gave you.',
        action: '/api/signup/join',
        submitLabel: 'Join',
        csrfToken: 'csrf-test',
        defaultOpen: true, // Render the form so the error <p> is reachable
      }),
    );

    expect(html).toContain('text-error');
    expect(html).not.toContain('text-danger');
  });

  it('renders the error <p> with background class "bg-error-soft" (NOT "bg-danger-soft")', () => {
    const html = renderToStaticMarkup(
      createElement(SignupCard, {
        id: 'join',
        icon: null,
        title: 'Join your school',
        description: 'Use the 6-character join code your admin gave you.',
        action: '/api/signup/join',
        submitLabel: 'Join',
        csrfToken: 'csrf-test',
        defaultOpen: true,
      }),
    );

    expect(html).toContain('bg-error-soft');
    expect(html).not.toContain('bg-danger-soft');
  });

  it('error <p> has role="alert" so screen readers announce it', () => {
    const html = renderToStaticMarkup(
      createElement(SignupCard, {
        id: 'join',
        icon: null,
        title: 'Join your school',
        description: 'Use the 6-character join code your admin gave you.',
        action: '/api/signup/join',
        submitLabel: 'Join',
        csrfToken: 'csrf-test',
        defaultOpen: true,
      }),
    );

    // Pin the a11y contract — the role attribute is what makes the
    // error accessible. Without it, error text is decorative.
    expect(html).toMatch(/role="alert"/);
  });

  it('does NOT render the error <p> when actionData has no error', () => {
    holder.actionData = undefined;

    try {
      const html = renderToStaticMarkup(
        createElement(SignupCard, {
          id: 'join',
          icon: null,
          title: 'Join your school',
          description: 'Use the 6-character join code your admin gave you.',
          action: '/api/signup/join',
          submitLabel: 'Join',
          csrfToken: 'csrf-test',
          defaultOpen: true,
        }),
      );

      // No alert role → no error rendered.
      expect(html).not.toMatch(/role="alert"/);
      expect(html).not.toContain('text-error');
    } finally {
      // Restore for other tests.
      holder.actionData = {
        error: 'Invalid invite code. Please check the link your admin sent.',
      };
    }
  });

  it('error <p> renders the error message text', () => {
    const html = renderToStaticMarkup(
      createElement(SignupCard, {
        id: 'join',
        icon: null,
        title: 'Join your school',
        description: 'Use the 6-character join code your admin gave you.',
        action: '/api/signup/join',
        submitLabel: 'Join',
        csrfToken: 'csrf-test',
        defaultOpen: true,
      }),
    );

    expect(html).toContain('Invalid invite code');
  });
});