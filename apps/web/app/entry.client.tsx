// apps/web/app/entry.client.tsx — RR7 client-side entry.
//
// Responsibility (per spec section 8):
//   1. Hydrate the SSR'd HTML that entry.server.tsx produced. We use
//      `hydrateRoot` (not `createRoot`) so React matches the server's
//      committed tree against the client tree and only patches diffs.
//   2. React 18 streaming SSR requires `hydrateRoot` to receive the
//      same root component that was passed to `renderToPipeableStream`,
//      which means we need to start at `<HydratedRouter>` per RR7 docs.
//
// Bot handling:
//   - Bots receive an empty <body> in the SSR stream because they don't
//     execute JS anyway. We never run this file for bot agents because
//     they bail at parse time. The `isbot` check from the server entry
//     is the authoritative gate.
//
// Errors during hydration:
//   - React 18 logs hydration mismatches with `console.error`. We do
//     not catch those here — if the SSR'd tree disagrees with what the
//     client would render, the page WILL re-mount on the client which
//     is the desired behavior. We rely on the ErrorBoundary in
//     `root.tsx` to render a recoverable error page on the client
//     side if hydration totally fails.

import { startTransition, StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
