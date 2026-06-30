// apps/web/app/entry.server.tsx — RR7 server-side entry.
//
// Responsibilities (per spec section 8):
//   1. Per-request structured logging. Each request gets a `requestId`
//      that propagates through the request lifecycle (set as
//      `X-Request-Id` response header so the client can correlate).
//   2. Honor `LOG_LEVEL` from the environment (set via env, not in
//      source). Reads at boot, falls back to `info` in prod / `debug`
//      in dev.
//   3. SSR via `renderToReadableStream` for non-bot requests (so the
//      client can begin streaming the response as React commits) and
//      `renderToString` (or full-document stream) for crawlers so they
//      can index the HTML without executing JS.
//
// Why an entry.server.tsx when RR7 ships a default:
//   - The default builds its own pino-equivalent at INFO level and
//     never threads a requestId into app code. We need that for
//     debugging production incidents ("show me everything that happened
//     during request X" is the canonical log query).
//
// Scope:
//   - Runs in the web container only. Never reaches the client bundle —
//     vite tree-shakes it out of the React Router compiler output.
//
// Requests that bypass this file (none in production):
//   - The vite dev middleware short-circuits to RR's plugin transform
//     for HMR; the entry is only invoked for full-document SSR.

import { PassThrough } from 'node:stream';

import {
  createReadableStreamFromReadable,
  type EntryContext,
} from '@react-router/node';
import { ServerRouter } from 'react-router';
import { isbot } from 'isbot';
import { renderToPipeableStream } from 'react-dom/server';
import { randomUUID } from 'node:crypto';

import { logger } from '../server/logger.server';

// RR7 requires `streamTimeout` for the response stream. Five minutes is
// the canonical default — long enough that very slow SSR (e.g. on a cold
// cache) doesn't time out, short enough that a runaway render gets cut.
export const streamTimeout = 5 * 60 * 1000;

/**
 * Mint a request id. Honors an inbound `X-Request-Id` header so callers
 * can correlate across services (e.g. an upstream nginx adds the id and
 * we log it on the way through).
 *
 * The id is a UUIDv4. UUIDs are 16 random bytes hex-encoded to 36 chars
 * — collision-resistant enough that even if we ran 1000 req/sec for a
 * year the chance of a single collision is ~10^-7.
 */
function mintRequestId(request: Request): string {
  const inbound = request.headers.get('x-request-id');
  if (inbound) return inbound;
  return randomUUID();
}

/**
 * Apply the baseline security headers that helmet would normally set.
 * RR7 doesn't run Express middleware, so we set these on the response
 * Headers object directly before SSR streams. CSP is intentionally
 * NOT included here — adding it requires auditing the design-system's
 * inline styles, which is a follow-up task (see audit R-15).
 *
 * Why not just call helmet() middleware: RR7's entry doesn't pass
 * through Express. We could wrap express + helmet as a sub-app but
 * that's a bigger change than just setting the headers we need.
 *
 * HSTS: only set in production (Set-Cookie + Secure imply HTTPS
 * already, but we want the browser to remember it for the next visit
 * without the Strict-Transport-Security header we send here).
 *
 * Content-Type MUST be set here, not just nosniff — browsers refuse
 * to sniff when nosniff is on, and without an explicit Content-Type
 * the HTML body is rendered as raw text. Caught by the post-deploy
 * browser re-test (verifier, 2026-06-30).
 */
function applySecurityHeaders(headers: Headers, isProduction: boolean): void {
  // Tell the browser the body is HTML. With X-Content-Type-Options:
  // nosniff below, the browser will NOT auto-detect — so this is
  // required for SSR pages to render at all.
  headers.set('Content-Type', 'text/html; charset=utf-8');
  // Prevent MIME-type sniffing (the browser must respect our declared type)
  headers.set('X-Content-Type-Options', 'nosniff');
  // Block clickjacking — EduSupervise never embeds in an iframe.
  // (If we add an embeddable widget later, switch to SAMEORIGIN.)
  headers.set('X-Frame-Options', 'DENY');
  // Limit referrer leakage — we send Referer only on same-origin
  // requests, not when following an off-site link to a parent alert.
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Restrict browser features the app doesn't need (geolocation,
  // microphone, payment, USB, etc.). Reduces XSS blast radius.
  headers.set('Permissions-Policy',
    'geolocation=(), microphone=(), camera=(), payment=(), usb=()');
  if (isProduction) {
    // 1-year HSTS — once a browser sees this on edusupervise.ashbi.ca
    // it will refuse to load the site over HTTP for the next 12 months.
    // Safe because the domain already serves valid HTTPS via Traefik.
    headers.set(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
  }
}

/**
 * Default handler exported by RR7's docs. We add per-request pino
 * logging on top: log start, log end with status + duration, and surface
 * any thrown error via the error boundary (which RR7 handles by calling
 * this handler with a non-200 response).
 */
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
): Promise<Response> {
  const requestId = mintRequestId(request);
  const startedAt = Date.now();
  const childLog = logger.child({
    requestId,
    method: request.method,
    url: request.url,
  });
  childLog.debug('request received');

  // Forward the request id back to the client so log correlation works
  // even when the request starts at a CDN or proxy.
  responseHeaders.set('X-Request-Id', requestId);

  // Apply baseline security headers (replaces missing helmet wiring —
  // audit slice-5 R-15). CSP is a follow-up because the design system
  // uses inline styles.
  applySecurityHeaders(responseHeaders, process.env.NODE_ENV === 'production');

  // CSRF cookie minting lives in the per-route loaders that need
  // the token (signup.tsx, login.tsx, _app.tsx, settings). They
  // attach Set-Cookie to their response AND return the token in
  // loader data. Doing it here would duplicate Set-Cookie headers
  // and produce races between two mints with different tokens.
  //
  // For routes WITHOUT a csrf-aware loader (e.g. /, /signup direct
  // nav with a fresh user), we still want a cookie on the browser
  // so the .data request that fires after the user clicks a card
  // has something to read. The signup loader's mint covers the
  // primary use case; for other routes we let the action-level
  // CSRF check fail-and-redirect if the cookie is missing.
  //
  // The single-source-of-truth mint is in csrf.server.ts#mintCsrfCookie.

  // Bots get the full HTML at once — they don't execute the hydration
  // JS so partial streams just slow down indexing. Humans get a
  // streamed response so the browser can begin painting committed chunks
  // as soon as React's renderer produces them.
  const isBot = isbot(request.headers.get('user-agent') ?? '');

  return new Promise((resolve, reject) => {
    let shellRendered = false;
    const onReady = isBot ? 'onAllReady' : 'onShellReady';

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        [onReady]() {
          shellRendered = true;
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );

          pipe(body);
          childLog.info(
            {
              status: responseStatusCode,
              durationMs: Date.now() - startedAt,
              stream: 'pipeable',
            },
            'request completed',
          );
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          // The first error in a stream is the most useful — subsequent
          // errors are usually downstream of it.
          if (shellRendered) {
            childLog.error({ err: error }, 'stream error');
          }
          responseStatusCode = 500;
        },
        // The React DOM renderer has its own internal timeout; we use
        // the npm default (no timeout) and rely on Node's HTTP server
        // for the keep-alive ceiling.
      },
    );

    // Abort the render if we exceed the per-request SSR budget. This
    // catches the case where a route's loader hangs on I/O.
    setTimeout(abort, streamTimeout);
  });
}
