// app/lib/analytics.ts
//
// Client-side analytics helper. Plausible only — see root.tsx for the
// script tag (conditional on PLAUSIBLE_DOMAIN env var).
//
// Usage:
//   import { trackEvent } from '~/lib/analytics';
//   trackEvent('app_store_click', { plan: 'free' });
//   trackEvent('duty_assigned', { role: 'teacher' });
//
// Plausible's `plausible()` global is set by the script tag. If the
// script isn't loaded (PLAUSIBLE_DOMAIN unset, or the user has an
// ad-blocker that nukes plausible.io), the calls are silent no-ops
// — analytics never breaks the UX.
//
// 12th-grade English on event names + props. One idea per event.

import { useEffect } from 'react';

// Type-safe global from Plausible. Falls back to `undefined` when
// the script isn't loaded.
type PlausibleFn = (
  event: string,
  options?: { props?: Record<string, string | number | boolean> },
) => void;

declare global {
  interface Window {
    plausible?: PlausibleFn;
  }
}

/**
 * Fire a Plausible custom event. SSR-safe (no-op on server).
 * If Plausible isn't loaded (ad-blocker, env not set), this is silent.
 */
export function trackEvent(
  event: string,
  props?: Record<string, string | number | boolean>,
): void {
  if (typeof window === 'undefined') return;
  if (typeof window.plausible !== 'function') return;
  try {
    if (props && Object.keys(props).length > 0) {
      window.plausible(event, { props });
    } else {
      window.plausible(event);
    }
  } catch {
    // Plausible shouldn't throw, but if it does, swallow — analytics
    // never breaks the UX.
  }
}

/**
 * React hook variant: fire an event on mount with optional props.
 * Useful for "page viewed" / "feature used" events.
 */
export function usePageView(event: string, props?: Record<string, string | number | boolean>): void {
  useEffect(() => {
    trackEvent(event, props);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event]);
}

/**
 * Convention: every custom event in this app should be one of these.
 * Add to this enum when you wire a new event so we don't get
 * "clicked_button" / "btn_click" / "user_did_thing" sprawl.
 */
export const ANALYTICS_EVENTS = {
  // Marketing-site events (run on https://edusupervise.ashbi.ca only,
  // not in the iOS app — the WKWebView is the same domain).
  APP_STORE_CLICK: 'app_store_click',
  PRICING_VIEW: 'pricing_view',
  CONTACT_SUBMIT: 'contact_submit',
  DEMO_REQUEST: 'demo_request',

  // Onboarding events (web + iOS).
  SIGNUP_STARTED: 'signup_started',
  SIGNUP_COMPLETED: 'signup_completed',
  ONBOARDING_PDF_UPLOAD: 'onboarding_pdf_upload',
  ONBOARDING_CALENDAR_COMMIT: 'onboarding_calendar_commit',

  // Product events (the value moments).
  DUTY_ASSIGNED: 'duty_assigned',
  COVERAGE_REQUEST_SENT: 'coverage_request_sent',
  COVERAGE_REQUEST_ANSWERED: 'coverage_request_answered',
  PUSH_NOTIFICATION_DELIVERED: 'push_notification_delivered',

  // Account lifecycle.
  ACCOUNT_DELETE_REQUESTED: 'account_delete_requested',
  ACCOUNT_DELETE_CONFIRMED: 'account_delete_confirmed',
} as const;

export type AnalyticsEvent =
  (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];
