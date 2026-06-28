// apps/web/public/sw.js — EduSupervise service worker.
//
// Scope: this worker ONLY handles Web Push events. No caching, no fetch
// interception, no offline shell — those concerns belong to a future
// PWA task that ships with a proper install / activate lifecycle.
//
// Why a separate, minimal worker:
//   - Registering `/sw.js` from `/` gives it scope `/`, which is exactly
//     what push needs (the push event fires on any path the SW controls).
//   - Adding caching later is additive — register a second worker at
//     `/sw-cache.js` with scope `/app/` instead of growing this file.
//   - Keeping the worker minimal means a push-only bug is easy to bisect.
//
// Payload contract (sent by server in apps/web/server/push.server.ts):
//   {
//     title: string,
//     body?: string | null,
//     linkUrl?: string | null,
//     tag?: string | null,
//     data?: Record<string, unknown> | null
//   }
// Anything missing falls back to a generic title and the EduSupervise icon.

/* eslint-disable no-restricted-globals */

const APP_ICON = '/icon-192.png';
const APP_BADGE = '/icon-96.png';
const DEFAULT_TITLE = 'EduSupervise';

/**
 * Map push payload to the NotificationOptions shape the browser expects.
 * Kept as a small named function so test / debug code can call it
 * without instantiating a real PushEvent.
 */
function buildNotificationOptions(payload) {
  var options = {
    body: payload && payload.body ? String(payload.body) : '',
    icon: APP_ICON,
    badge: APP_BADGE,
    requireInteraction: false,
    tag: payload && payload.tag ? String(payload.tag) : 'edusupervise',
    renotify: Boolean(payload && payload.tag),
    data: {
      linkUrl: payload && payload.linkUrl ? String(payload.linkUrl) : null,
      receivedAt: new Date().toISOString(),
      payload: payload && payload.data ? payload.data : null
    }
  };
  return options;
}

/**
 * Resolve a linkUrl to a full URL inside our origin. linkUrl may be:
 *   - a full URL (https://edusupervise.ashbi.ca/app/notifications) — use as-is
 *   - a path (/app/notifications) — prefix with self.location.origin
 *   - null/undefined — fall back to the app root
 */
function resolveNotificationUrl(linkUrl) {
  if (!linkUrl) return self.location.origin + '/app';
  try {
    var parsed = new URL(linkUrl, self.location.origin);
    // Refuse to navigate outside our origin (defense-in-depth against a
    // compromised push payload).
    if (parsed.origin !== self.location.origin) {
      return self.location.origin + '/app';
    }
    return parsed.toString();
  } catch (e) {
    return self.location.origin + '/app';
  }
}

self.addEventListener('push', function (event) {
  if (!event || !event.data) {
    // No payload — show a generic notification so the user gets SOME
    // signal. This branch fires if a server sends a push without a body,
    // which is unusual but not impossible (e.g. a ping).
    event.waitUntil(
      self.registration.showNotification(DEFAULT_TITLE, {
        body: 'You have a new notification.',
        icon: APP_ICON,
        badge: APP_BADGE,
        tag: 'edusupervise'
      })
    );
    return;
  }

  var payload;
  try {
    payload = event.data.json();
  } catch (e) {
    // Payload wasn't valid JSON — show a generic notification rather
    // than throwing inside the worker (uncaught errors here kill the
    // worker until the next page load).
    event.waitUntil(
      self.registration.showNotification(DEFAULT_TITLE, {
        body: 'You have a new notification.',
        icon: APP_ICON,
        badge: APP_BADGE,
        tag: 'edusupervise'
      })
    );
    return;
  }

  var title = payload && payload.title ? String(payload.title) : DEFAULT_TITLE;
  var options = buildNotificationOptions(payload);

  event.waitUntil(
    self.registration.showNotification(title, options).then(function () {
      return self.registration.getNotifications().then(function (existing) {
        // Bound the count to avoid memory growth on chatty accounts.
        // Older notifications stay; we only count, never auto-dismiss.
        if (existing && existing.length > 50) {
          // No-op: surfacing for future cleanup logic. We intentionally
          // don't close notifications here — the OS handles retention.
        }
      });
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var linkUrl = event.notification.data && event.notification.data.linkUrl;
  var target = resolveNotificationUrl(linkUrl);

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (clientList) {
        // If a window is already open at the target path, focus it.
        for (var i = 0; i < clientList.length; i += 1) {
          var client = clientList[i];
          if (!client || !client.url) continue;
          try {
            var parsed = new URL(client.url);
            if (parsed.origin === self.location.origin && parsed.pathname === new URL(target, self.location.origin).pathname) {
              return client.focus();
            }
          } catch (e) {
            // ignore malformed client URL
          }
        }
        // Otherwise open a new window.
        if (self.clients && self.clients.openWindow) {
          return self.clients.openWindow(target);
        }
        return null;
      })
  );
});

self.addEventListener('pushsubscriptionchange', function (event) {
  // The browser invalidated our subscription (user cleared site data,
  // endpoint was rotated, etc). The server only learns of this on the
  // next 410 Gone — we proactively resubscribe to keep things tight.
  if (!event || !event.oldSubscription) return;
  // Best-effort: re-subscribe using the same public key the server
  // originally issued. We can't fetch the VAPID key here without an
  // /api/push/vapid-key endpoint, so we tell the SW via a postMessage
  // from the page (see PushPermissionPrompt.tsx).
  // For now we do nothing — the server sweep handles 410 on next send.
});