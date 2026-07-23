// apps/mobile/app/_layout.tsx
//
// Root layout for the EduSupervise mobile app. Two responsibilities
// from slice C (push notifications):
//
//   1. After the user authenticates, register the device for Expo
//      Push notifications. Re-registers on every foreground so a
//      new token (token rotation, app reinstall) reaches the server.
//
//   2. Listen for push taps. On a tap, parse the payload, validate
//      the deep-link fields with a strict UUID v4 regex (security
//      review E-007), and router.push the resulting screen.
//
// The auth + cookie flow is owned by slice A. This file calls into
// slice A's helpers via three callbacks that slice A is expected
// to export from `apps/mobile/src/lib/api.ts`:
//
//   - isAuthenticated(): boolean
//   - getCookieHeader(): Promise<string>
//   - getCsrfToken():    Promise<string | null>
//
// In dev (slice A not yet wired), this file degrades gracefully:
//   - isAuthenticated() returns false → no registration, no listener
//   - getCookieHeader/getCsrfToken returning null → no registration
//     but the listener still installs and is a no-op on tap until
//     the user is signed in.

import { AppState } from 'react-native';
import { useEffect, useRef } from 'react';
import { Slot, router } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { isAuthenticated, getCookieHeader, getCsrfToken } from '../src/lib/api';
import {
  registerForPushNotifications,
  unregisterForPushNotifications,
  buildDeepLinkFromPush,
  type MobilePushData,
} from '../src/lib/push';

// Show notifications while the app is foregrounded. Background
// notifications are handled by the OS automatically.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export default function RootLayout() {
  // Track the most-recently-registered token so we can unregister
  // on logout (slice A's auth flow calls the unregister helper).
  const lastTokenRef = useRef<string | null>(null);

  // Push tap listener — installed ONCE at mount. Survives auth
  // changes (which is what we want: a tap from a notification
  // tray, while the user is logged out, should still open the
  // app and route them to the login screen if the link requires
  // auth).
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data as
          | MobilePushData
          | undefined;
        // STRICT UUID validation happens inside buildDeepLinkFromPush
        // (security review E-007). We never trust the data payload
        // shape or values — the helper's only output is one of two
        // safe pathname+params tuples.
        const target = buildDeepLinkFromPush(data);
        try {
          router.push({ pathname: target.pathname, params: target.params });
        } catch {
          // If the route is missing (slice B not yet shipped), we
          // silently fail to the root instead of crashing the app.
          // The notification is still recorded in the tray.
          try {
            router.push('/');
          } catch {
            /* give up gracefully */
          }
        }
      },
    );
    return () => {
      subscription.remove();
    };
  }, []);

  // Re-register at mount and whenever the app returns to the foreground.
  // Auth is read from SecureStore on every invocation, so a login that
  // happens after the root layout mounts is picked up on the next active
  // transition without relying on React state from the sign-in screen.
  useEffect(() => {
    let cancelled = false;

    const syncPushRegistration = async () => {
      const authed = await isAuthenticated();
      if (cancelled) return;

      if (!authed) {
        // Logout: revoke the previously-registered token. The
        // mobile app's logout flow (slice A) also clears the
        // session/CSRF cookies; we revoke the push token here
        // to match the server-side expectation.
        if (lastTokenRef.current) {
          await unregisterForPushNotifications(
            lastTokenRef.current,
            getCookieHeader,
            getCsrfToken,
          ).catch(() => {
            /* best-effort */
          });
          lastTokenRef.current = null;
        }
        return;
      }

      // Authed: register. The server-side upsert is idempotent
      // (UNIQUE(school_id, user_id, expo_push_token)) so this is
      // safe to call on every app foreground.
      const result = await registerForPushNotifications(
        getCookieHeader,
        getCsrfToken,
      );
      if (cancelled) return;
      if (result.ok) {
        lastTokenRef.current = result.token;
      }
      // Failure: log via console; the app still works (no push,
      // but the user has email/SMS fallbacks). Slice D's
      // EAS-build step is where the projectId gets set; a
      // 'no_project_id' result here usually means EAS isn't
      // configured yet.
    };

    void syncPushRegistration();
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncPushRegistration();
    });

    return () => {
      cancelled = true;
      appStateSubscription.remove();
    };
  }, []);

  return <Slot />;
}
