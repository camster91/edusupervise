// apps/web/app/routes/verify-phone.tsx — /verify-phone (UI).
//
// Two-step form: enter phone → receive code → enter code. Each step
// POSTs to /auth/verify-phone with `verb=request` or `verb=confirm`.
//
// For development the SMS code is logged to stderr by the server
// (auth.verify-phone.tsx). In production the SMS adapter (wired in a
// future task) sends via Twilio.

import { useState } from 'react';

import {
  buildCsrfSetCookie,
  CSRF_COOKIE_NAME,
  generateCsrfToken,
} from '~/server/csrf.server';

import type { Route } from './+types/verify-phone';

export async function loader({ request }: Route.LoaderArgs) {
  const cookieHeader = request.headers.get('cookie') ?? '';
  const hasCsrf = cookieHeader.split(';').some((p) => p.trim().startsWith(`${CSRF_COOKIE_NAME}=`));
  const headers = new Headers();
  let csrf = '';
  if (!hasCsrf) {
    csrf = generateCsrfToken();
    headers.append('set-cookie', buildCsrfSetCookie(csrf));
  } else {
    for (const p of cookieHeader.split(';')) {
      const [name, ...rest] = p.trim().split('=');
      if (name === CSRF_COOKIE_NAME) csrf = rest.join('=');
    }
  }
  return new Response(render(csrf), {
    headers: { ...Object.fromEntries(headers), 'content-type': 'text/html; charset=utf-8' },
  });
}

function render(csrf: string): string {
  // We split the UI into two stacked forms; React state below.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Verify phone — EduSupervise</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 24rem; margin: 4rem auto; padding: 0 1rem; }
    label { display: block; margin-top: 1rem; font-size: 0.9rem; }
    input { display: block; width: 100%; padding: 0.5rem; margin-top: 0.25rem; box-sizing: border-box; }
    button { margin-top: 1.5rem; padding: 0.6rem 1.2rem; }
    .hidden { display: none; }
    .error { color: #b00020; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Verify your phone</h1>
  <div id="step1">
    <form id="req-form" method="post" action="/auth/verify-phone">
      <input type="hidden" name="_csrf" value="${escapeAttr(csrf)}" />
      <input type="hidden" name="verb" value="request" />
      <label>Phone (E.164, e.g. +14165551234)<input type="tel" name="phone" required pattern="^\\+[1-9]\\d{6,14}$" /></label>
      <button type="submit">Send code</button>
    </form>
  </div>
  <div id="step2" class="hidden">
    <form id="confirm-form" method="post" action="/auth/verify-phone">
      <input type="hidden" name="_csrf" value="${escapeAttr(csrf)}" />
      <input type="hidden" name="verb" value="confirm" />
      <label>Phone<input type="tel" name="phone" required id="confirm-phone" /></label>
      <label>Code<input type="text" name="code" required inputmode="numeric" pattern="\\d{4,8}" /></label>
      <button type="submit">Verify</button>
    </form>
  </div>
  <p id="err" class="error"></p>
  <script>
    // After the request form submits, swap to step 2 (we keep the phone
    // value). For dev convenience, the server logs the code to stderr;
    // in production the SMS adapter sends it.
    document.getElementById('req-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const res = await fetch(ev.target.action, { method: 'POST', body: fd });
      if (res.ok) {
        document.getElementById('step1').classList.add('hidden');
        document.getElementById('step2').classList.remove('hidden');
        document.getElementById('confirm-phone').value = fd.get('phone');
      } else {
        document.getElementById('err').textContent = 'Could not send code. Try again later.';
      }
    });
    document.getElementById('confirm-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const res = await fetch(ev.target.action, { method: 'POST', body: fd });
      if (res.ok) {
        location.href = '/app/profile';
      } else {
        document.getElementById('err').textContent = 'Wrong or expired code.';
      }
    });
  </script>
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export default function VerifyPhonePage() {
  // The actual UI is rendered as static HTML by the loader above so the
  // form works without hydration. This default export exists so RR7's
  // route manifest is happy; the loader's HTML response is what the
  // browser actually shows.
  const [step, setStep] = useState<'request' | 'confirm'>('request');
  void step;
  return null;
}