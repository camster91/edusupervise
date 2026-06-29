/**
 * Minimal pino-compatible JSON logger for the worker.
 *
 * Why not pino itself? The provider-adapter packages already documented the
 * same issue: pino 9.x transitively pulls `sonic-boom`, whose `[Symbol.hasInstance]`
 * is not callable when the module is loaded through vite SSR loader + a
 * pnpm-symlinked CJS tree on Node 24. That throws
 * `TypeError: Right-hand side of 'instanceof' is not callable` at the first
 * `pino()` call. The worker runs the same Node runtime, so the failure mode
 * is identical.
 *
 * For an adapter that only needs to dump a few structured fields per event,
 * a 40-line JSON writer is fine. The output format matches pino's standard
 * schema (`{ level, time, pid, hostname, name, msg, ...bindings }`) so any
 * downstream tooling that parses pino logs keeps working.
 *
 * Borrowed wholesale from `@edusupervise/email`'s in-package logger so the
 * worker, email, sms, and billing-adapter all use the same shape.
 */
import { hostname } from 'node:os';

export interface LoggerBindings {
  name?: string;
  level?: number | string;
  [key: string]: unknown;
}

export interface Logger {
  info(bindings: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(bindings: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(bindings: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  debug(bindings: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

const LEVEL_NAMES: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

function resolveLevel(input: number | string | undefined): number {
  if (typeof input === 'number') return input;
  if (typeof input === 'string') {
    const lower = input.toLowerCase();
    const named: Record<string, number> = {
      trace: 10,
      debug: 20,
      info: 30,
      warn: 40,
      error: 50,
      fatal: 60,
      silent: 100,
    };
    if (lower in named) return named[lower]!;
    const parsed = Number.parseInt(lower, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 30; // info default
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { type: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
}

/** Coerce overloaded arguments into the (bindings, msg) shape. */
function parseArgs(
  a: Record<string, unknown> | string,
  b: string | undefined,
): [Record<string, unknown>, string] {
  if (typeof a === 'string') return [{}, a];
  return [a, b ?? ''];
}

class JsonLogger implements Logger {
  private readonly base: Record<string, unknown>;
  private readonly minLevel: number;
  private readonly name: string;
  private readonly host: string;
  private readonly pid: number;

  constructor(opts: LoggerBindings = {}) {
    this.name = (opts.name as string) ?? 'app';
    this.minLevel = resolveLevel(opts.level);
    this.host = hostname();
    this.pid = process.pid;
    const { name: _n, level: _l, ...rest } = opts;
    this.base = rest;
  }

  private emit(level: number, bindings: Record<string, unknown>, msg: string): void {
    if (level < this.minLevel) return;
    const normalized: Record<string, unknown> = { ...this.base };
    for (const [k, v] of Object.entries(bindings)) {
      if (k === 'err' && v instanceof Error) {
        normalized.err = serializeError(v);
      } else {
        normalized[k] = v;
      }
    }
    const line = JSON.stringify({
      level,
      time: Date.now(),
      pid: this.pid,
      hostname: this.host,
      name: this.name,
      msg,
      ...normalized,
    });
    const stream = level >= 50 ? process.stderr : process.stdout;
    stream.write(line + '\n');
  }

  info(bindings: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  info(a: Record<string, unknown> | string, b?: string): void {
    const [bn, m] = parseArgs(a, b);
    this.emit(30, bn, m);
  }
  warn(bindings: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(a: Record<string, unknown> | string, b?: string): void {
    const [bn, m] = parseArgs(a, b);
    this.emit(40, bn, m);
  }
  error(bindings: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(a: Record<string, unknown> | string, b?: string): void {
    const [bn, m] = parseArgs(a, b);
    this.emit(50, bn, m);
  }
  debug(bindings: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(a: Record<string, unknown> | string, b?: string): void {
    const [bn, m] = parseArgs(a, b);
    this.emit(20, bn, m);
  }

  child(bindings: Record<string, unknown>): Logger {
    const child = Object.create(JsonLogger.prototype) as JsonLogger;
    const parent = this as unknown as JsonLogger;
    (child as unknown as { base: Record<string, unknown> }).base = {
      ...parent.base,
      ...bindings,
    };
    (child as unknown as { minLevel: number }).minLevel = parent.minLevel;
    (child as unknown as { name: string }).name = parent.name;
    (child as unknown as { host: string }).host = parent.host;
    (child as unknown as { pid: number }).pid = parent.pid;
    return child as unknown as Logger;
  }
}

export function pinoLike(opts: LoggerBindings = {}): Logger {
  return new JsonLogger(opts);
}

export { LEVEL_NAMES };
