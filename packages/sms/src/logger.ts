/**
 * Minimal pino-compatible JSON logger.
 *
 * Why not pino itself? Pino 9.x loads `sonic-boom` lazily inside its
 * constructor and runs `opts instanceof SonicBoom` to detect stream args. In
 * Node 24 + pnpm's symlinked tree + any ESM/CJS interop layer (vite SSR loader,
 * tsx, esbuild, etc.) the imported `SonicBoom` symbol can arrive as a
 * Proxy-wrapped module namespace whose `[Symbol.hasInstance]` is not callable.
 * That throws `TypeError: Right-hand side of 'instanceof' is not callable`
 * during `pino()` initialization — a runtime error, not a test issue.
 *
 * For an adapter that only needs to dump a few structured fields per event,
 * a 40-line JSON writer is fine. The output format matches pino's standard
 * schema (`{ level, time, pid, hostname, name, msg, ...bindings }`) so any
 * downstream tooling that parses pino logs keeps working.
 */

import { hostname } from 'node:os';

export interface LoggerBindings {
  name?: string;
  level?: number | string;
  [key: string]: unknown;
}

export interface Logger {
  info(bindings: Record<string, unknown>, msg: string): void;
  warn(bindings: Record<string, unknown>, msg: string): void;
  error(bindings: Record<string, unknown>, msg: string): void;
  debug(bindings: Record<string, unknown>, msg: string): void;
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

/** Serialize an Error into a plain object the way pino does. */
function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      type: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return { value: String(err) };
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

    // Pino stores err under `err` key; we honour that.
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

    // Pino writes INFO+ to stdout and WARN/ERROR to stderr.
    const stream = level >= 50 ? process.stderr : process.stdout;
    stream.write(line + '\n');
  }

  info(bindings: Record<string, unknown>, msg: string): void {
    this.emit(30, bindings, msg);
  }
  warn(bindings: Record<string, unknown>, msg: string): void {
    this.emit(40, bindings, msg);
  }
  error(bindings: Record<string, unknown>, msg: string): void {
    this.emit(50, bindings, msg);
  }
  debug(bindings: Record<string, unknown>, msg: string): void {
    this.emit(20, bindings, msg);
  }

  child(bindings: Record<string, unknown>): Logger {
    const child = Object.create(JsonLogger.prototype) as JsonLogger;
    // Bypass the constructor: directly compose the new instance state.
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

/** Create a logger compatible with `pino({ name, level })`. */
export function pinoLike(opts: LoggerBindings = {}): Logger {
  return new JsonLogger(opts);
}

export { LEVEL_NAMES };