// apps/web/app/lib/push.ts — client-side Web Push subscription helper.
//
// Called from any authenticated route after mount (e.g. the home page).
// On browsers that support the Push API + a service worker, this asks
// for notification permission, subscribes via pushManager.subscribe(),
// and POSTs the subscription to /api/push/register. The server stores
// it in push_subscriptions; the dispatcher uses it on the next push.
//
// On browsers without Push API support (older Safari, in-app webviews
// that aren't Capacitor), or where the user denies permission, this is
// a no-op — push remains a noop for those sessions.
//
// iOS path: WKWebView (Capacitor) doesn't support PushManager. The
// iOS-side registerIosPush() helper calls @capacitor/push-notifications
// directly and POSTs the APNs token to the same /api/push/register
// endpoint under the 'ios' platform claim.

import { apiFetch } from './api';

const SW_URL = '/sw.js';

export interface RegisterPushResult {
  ok: boolean;
  reason?: 'unsupported' | 'permission-denied' | 'no-service-worker' | 'subscribe-failed' | 'network-error';
}

/**
 * Register this browser for Web Push. Idempotent — re-calling is fine.
 * Returns ok=false with a reason if Push isn't available or the user
 * denied permission; callers should not surface those as errors.
 */
export async function registerWebPush(): Promise<RegisterPushResult> {
  if (typeof window === 'undefined') return { ok: false, reason: 'unsupported' };
  if (!('serviceWorker' in navigator)) return { ok: false, reason: 'no-service-worker' };
  if (!('PushManager' in window)) return { ok: false, reason: 'unsupported' };

  // Permission gate.
  const permission = await Notification.requestPermission().catch(() => 'denied');
  if (permission !== 'granted') {
    return { ok: false, reason: 'permission-denied' };
  }

  // Wait for the SW. Capacitor's WKWebView ships its own SW at /sw.js
  // for push events; the same registration works in both contexts.
  let reg: ServiceWorkerRegistration;
  try {
    reg = await navigator.serviceWorker.register(SW_URL);
    await navigator.serviceWorker.ready;
  } catch {
    return { ok: false, reason: 'no-service-worker' };
  }

  // Use the existing subscription if we already have one — pushManager.subscribe
  // returns the same subscription when called with the same applicationServerKey.
  let sub: PushSubscription | null = reg.pushManager.getSubscription
    ? await reg.pushManager.getSubscription()
    : null;
  if (!sub) {
    const vapidKey = await fetchVapidKey();
    if (!vapidKey) return { ok: false, reason: 'subscribe-failed' };
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    } catch {
      return { ok: false, reason: 'subscribe-failed' };
    }
  }

  // Convert the PushSubscription to the wire format the server expects.
  const json = sub.toJSON();
  const endpoint = json.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return { ok: false, reason: 'subscribe-failed' };
  }

  try {
    await apiFetch('/api/push/register', {
      method: 'POST',
      body: {
        platform: 'web',
        subscription: { endpoint, keys: { p256dh, auth } },
        userAgent: navigator.userAgent.slice(0, 500),
      },
    });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'network-error' };
  }
}

/**
 * Fetch the VAPID public key from the server. We don't ship it in the
 * bundle — the server rotates it by redeploying with new env values,
 * and the SW re-subscribes on next page load.
 */
async function fetchVapidKey(): Promise<string | null> {
  try {
    const r = await fetch('/api/push/vapid-public-key');
    if (!r.ok) return null;
    const body = (await r.json()) as { publicKey?: string };
    return body.publicKey ?? null;
  } catch {
    return null;
  }
}

/**
 * Convert a base64url-encoded VAPID public key to a Uint8Array for
 * PushManager.subscribe. PushManager expects an ArrayBuffer of raw bytes.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Detect the Capacitor runtime (iOS app) so we can dispatch to the
 * iOS registration path instead of Web Push. Returns null in a normal
 * browser.
 */
export function getCapacitor(): typeof window.Capacitor | null {
  if (typeof window === 'undefined') return null;
  const cap = (window as unknown as { Capacitor?: unknown }).Capacitor;
  if (!cap || typeof cap !== 'object') return null;
  return cap as typeof window.Capacitor;
}