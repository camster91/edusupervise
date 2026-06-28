// apps/web/server/logger.server.ts — structured logger for server modules.
//
// Wraps pino with the project-wide configuration. Kept tiny: one
// shared logger instance, configurable via LOG_LEVEL env var, with
// pretty-printing on local dev and JSON output in production.
//
// Why pino: Tier 1 already depends on pino (~9.5.0) and pino-pretty
// (~11.3.0). We re-export from a single module so server-side files
// import a known-shape logger instead of constructing their own.

import { pino, type Logger } from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger: Logger = pino({
  name: 'edusupervise-web',
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l' },
        },
      }
    : {}),
});

/**
 * Child logger factory — used in server modules that need request-scoped
 * context. Example:
 *
 *   const log = logger.child({ route: 'api.push.subscribe' });
 *   log.info({ userId }, 'subscribing');
 */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}