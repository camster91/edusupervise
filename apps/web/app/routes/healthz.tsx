// apps/web/app/routes/healthz.tsx — Standard healthcheck endpoints.
//
// Wired at `/healthz` and `/health` per RR7 routes.ts registration.
// Runs the same shape as `/api/health` (DB ping + uptime) but is
// anonymous and returns 200/503 suitable for an orchestrator probe.
//
// Why two paths for the same handler: ops folks and container
// orchestrators vary in which one they expect. Supporting both is
// cheaper than asking everyone to standardize.
//
// Why we record the metric here instead of letting entry.server.tsx
// do it via onShellReady: `/healthz` and `/api/health` are RESOURCE
// routes (no `default` export). RR7 returns the loader's Response
// directly without calling renderToPipeableStream, so the onShellReady
// hook inside entry.server.tsx never fires for them. Calling
// `recordHttpRequest` from inside the loader is the supported
// workaround (audit B10, 2026-07-04).
import type { Route } from './+types/healthz';
import { sql } from 'drizzle-orm';
import { getDb } from '../../server/db.server.ts';
import {
  recordHttpRequest,
  routePatternFor,
} from '../../server/metrics.server.ts';

export async function loader(request: Request): Promise<Response> {
  const startedAt = Date.now();
  let dbOk = false;
  let dbError: string | undefined;
  const checkStart = Date.now();
  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
    dbOk = true;
  } catch (err) {
    dbError = err instanceof Error ? err.message : 'unknown';
  }
  const ok = dbOk;
  const body = {
    status: ok ? 'ok' : 'degraded',
    db: dbOk ? 'ok' : 'down',
    // (intentionally do NOT leak dbError to public callers - operators find it in pino logs)
    uptime_s: Math.floor(process.uptime()),
    check_ms: Date.now() - checkStart,
  };
  const status = ok ? 200 : 503;
  // Resource-route metric recording (see header comment).
  recordHttpRequest(
    request.method,
    routePatternFor(new URL(request.url).pathname),
    status,
    (Date.now() - startedAt) / 1000,
  );
  return Response.json(body, { status });
}
