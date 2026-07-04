// apps/web/app/routes/metrics.tsx — Prometheus scrape endpoint.
//
// Returns the Registry from `metrics.server.ts` as
// `text/plain; version=0.0.4` (Prometheus exposition format).
//
// Why a top-level route (not `/api/metrics`):
//   - Standard convention is `/metrics` at the root path so the
//     scraper config stays uniform across services.
//   - Load balancers + scrapers convention exclude `/metrics` from
//     session cookies; we keep it anonymous on purpose.
//
// Auth: open by design. The endpoint exposes counters, durations,
// and process stats — no tenant data, no user IDs. Restrict at the
// firewall layer (Traefik middleware, scrape from VPC only) rather
// than application-level.
//
// Why we record the metric here instead of via entry.server.tsx:
// `/metrics` is a RESOURCE route (no `default` export). RR7 returns
// the loader's Response directly without calling
// renderToPipeableStream, so the onShellReady hook never fires.
// Calling `recordHttpRequest` from the loader is the supported
// workaround (audit B10, 2026-07-04).
//
// Note: we exclude `/metrics` from the HISTOGRAM in
// `entry.server.tsx` (label guard), but the resource-route loader
// records it directly. To prevent self-observation, the entry-side
// guard is enough — but we ALSO pass the bare literal label here so
// even if both paths record, the metric is bucketed under a single
// route. In practice entry.server.tsx short-circuits the resource
// route so only this loader runs.
import type { Route } from './+types/metrics';
import {
  registry,
  recordHttpRequest,
  setBackupLastSuccess,
} from '../../server/metrics.server.ts';
import { readFile } from 'node:fs/promises';

const BACKUP_STAMP_FILE =
  '/var/lib/node_exporter/edusupervise_backup_last_success';

export async function loader(request: Request): Promise<Response> {
  const startedAt = Date.now();
  // Pick up backup.sh's last successful timestamp on each scrape so
  // the gauge refreshes without restarting the process. If the file
  // is missing (e.g. a fresh deploy before any backup has run), the
  // gauge stays at 0 — PromQL
  // `time() - backup_last_success_timestamp_seconds > 86400`
  // will alert on stale backups.
  try {
    const raw = await readFile(BACKUP_STAMP_FILE, 'utf8');
    const ts = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(ts) && ts > 0) {
      setBackupLastSuccess(ts);
    }
  } catch {
    // File missing is normal pre-first-backup; the gauge stays at
    // zero.
  }

  const body = await registry.metrics();
  recordHttpRequest(
    request.method,
    // Self-observation: label the histogram with a sentinel so a
    // dashboard alert can exclude this scraper from per-route SLOs.
    'metrics-scrape',
    200,
    (Date.now() - startedAt) / 1000,
  );
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': registry.contentType,
      'Cache-Control': 'no-store',
    },
  });
}
