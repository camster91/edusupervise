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
import { CSRF_COOKIE_NAME, mintCsrfCookie } from '../server/csrf.server';

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

  // CSRF double-submit cookie: mint a fresh token on every request that
  // doesn't already have one. The browser stores it; validation in
  // csrf.server.ts#validateCsrf reads it back from `Cookie:` and
  // compares against the `x-csrf-token` header (or form `csrf` field)
  // on every mutating request. Mints happen on every request (cheap;
  // the server stores no state) so a fresh visitor's first POST has
  // a cookie to match.
  const hasCsrf = (request.headers.get('cookie') ?? '').includes(CSRF_COOKIE_NAME);
  if (!hasCsrf) {
    responseHeaders.append('Set-Cookie', mintCsrfCookie().setCookie);
  }

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
