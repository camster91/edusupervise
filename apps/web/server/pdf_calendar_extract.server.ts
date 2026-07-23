// apps/web/server/pdf_calendar_extract.server.ts
//
// Phase 3 — PDF calendar ingestion.
//
// Shells out to apps/web/server/pdf_calendar_extract.py (stdlib +
// pdfplumber) to extract one row per date from a 5-day cycle
// elementary school calendar PDF (YRDSB template).
//
// Validates the JSON shape, defends against malformed python output,
// and caches the parse result in Redis under `cal:{jobId}` for 24h.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import IORedis from 'ioredis';
import { logger } from './logger.server';

const execFileAsync = promisify(execFile);

export const KNOWN_HOLIDAY_CODES = ['B', 'E', 'ES', 'M', '0'] as const;
export type HolidayCode = (typeof KNOWN_HOLIDAY_CODES)[number] | null;

export interface CalendarDay {
  date: string;
  month: number;
  day: number;
  weekday: string;
  cycleDay: number | null;
  isInstructional: boolean;
  holidayCode: HolidayCode;
  /** Optional parser note ('exam day', 'half day'). Currently
   *  unused but reserved for forward-compat. */
  note?: string | null;
}

export interface CalendarSummary {
  totalDays: number;
  instructionalDays: number;
  paDays: number;
  mandatoryHolidays: number;
  byCode: Record<string, number>;
}

export interface ParseSuccess {
  ok: true;
  jobId: string;
  sha256: string;
  calendarTitle: string;
  schoolYear: string;
  days: CalendarDay[];
  summary: CalendarSummary;
  durationMs: number;
}

export interface ParseFailure {
  ok: false;
  jobId: string;
  sha256: string;
  code:
    | 'pdfplumber_crashed'
    | 'pdfplumber_missing'
    | 'scanned_pdf'
    | 'timeout'
    | 'no_usable_calendar'
    | 'invalid_pdf'
    | 'file_not_found'
    | 'shape_mismatch'
    | 'unknown';
  message: string;
}

export type ParseOutcome = ParseSuccess | ParseFailure;

let redis: IORedis | null = null;
function getRedis(): IORedis | null {
  if (redis) return redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  redis = new IORedis(url, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  redis.on('error', (err) => {
    logger.warn({ err }, 'pdf_calendar_extract: redis error (cache disabled)');
  });
  return redis;
}

const CACHE_TTL_SEC = 24 * 60 * 60;
function cacheKey(jobId: string): string {
  return `cal:${jobId}`;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PY_SCRIPT = path.join(HERE, 'pdf_calendar_extract.py');
const PY_BIN = process.env.PDF_CALENDAR_PYTHON ?? 'python3';
const PY_TIMEOUT_MS = 8_000;

export async function parseCalendarPdf(args: {
  filePath: string;
  sha256: string;
  now?: Date;
}): Promise<ParseOutcome> {
  const start = Date.now();
  const jobId = randomUUID();

  if (!existsSync(args.filePath)) {
    return {
      ok: false,
      jobId,
      sha256: args.sha256,
      code: 'file_not_found',
      message: 'Staged file vanished before parsing started.',
    };
  }
  if (!existsSync(PY_SCRIPT)) {
    logger.error(
      { PY_SCRIPT },
      'pdf_calendar_extract: python script missing on disk',
    );
    return {
      ok: false,
      jobId,
      sha256: args.sha256,
      code: 'pdfplumber_missing',
      message: 'Calendar parser service is offline.',
    };
  }

  let stdout = '';
  let stderr = '';
  try {
    const r = await execFileAsync(PY_BIN, [PY_SCRIPT, args.filePath], {
      timeout: PY_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      // SECURITY: curated env whitelist. Same rationale as
      // apps/web/server/pdf-parser.server.ts — never spread process.env
      // into a subprocess. Audit 2026-07-22 P1-3.
      env: {
        PATH: process.env.PATH ?? '',
        LANG: process.env.LANG ?? 'C.UTF-8',
        PYTHONUNBUFFERED: '1',
        PYTHONHASHSEED: process.env.PYTHONHASHSEED ?? '',
      },
    });
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & {
      killed?: boolean;
      code?: string | number;
      stdout?: string;
      stderr?: string;
    };
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';

    if (e.killed) {
      return {
        ok: false,
        jobId,
        sha256: args.sha256,
        code: 'timeout',
        message: 'Parsing took too long — try a smaller PDF.',
      };
    }
    if (e.code === 'ENOENT') {
      return {
        ok: false,
        jobId,
        sha256: args.sha256,
        code: 'pdfplumber_missing',
        message: 'Calendar parser service is offline.',
      };
    }
    logger.error(
      { err, stderr: stderr.slice(0, 500) },
      'pdf_calendar_extract: execFile failed',
    );
    return {
      ok: false,
      jobId,
      sha256: args.sha256,
      code: 'pdfplumber_crashed',
      message: "Couldn't read this PDF — try another file.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    logger.error(
      { stdoutSlice: stdout.slice(0, 200), stderrSlice: stderr.slice(0, 200) },
      'pdf_calendar_extract: invalid JSON from python',
    );
    return {
      ok: false,
      jobId,
      sha256: args.sha256,
      code: 'pdfplumber_crashed',
      message: "Couldn't read this PDF — try another file.",
    };
  }

  const obj = parsed as { ok?: unknown; error?: unknown; detail?: unknown };
  if (obj?.ok === false) {
    const code = typeof obj.error === 'string' ? obj.error : 'unknown';
    const detail = typeof obj.detail === 'string' ? obj.detail : '';
    return {
      ok: false,
      jobId,
      sha256: args.sha256,
      code: mapPythonError(code),
      message: detail || pythonDefaultMessage(code),
    };
  }

  const validated = validateShape(parsed);
  if (!validated.ok) {
    return {
      ok: false,
      jobId,
      sha256: args.sha256,
      code: 'shape_mismatch',
      message: validated.message,
    };
  }

  const summary = computeSummary(validated.days);
  const out: ParseSuccess = {
    ok: true,
    jobId,
    sha256: args.sha256,
    calendarTitle: validated.calendarTitle,
    schoolYear: validated.schoolYear,
    days: validated.days,
    summary,
    durationMs: Date.now() - start,
  };

  await cacheOutcome(out);
  return out;
}

interface ShapeOk {
  ok: true;
  calendarTitle: string;
  schoolYear: string;
  days: CalendarDay[];
}
interface ShapeFail {
  ok: false;
  message: string;
}

function validateShape(raw: unknown): ShapeOk | ShapeFail {
  const r = raw as {
    calendar?: { title?: unknown; schoolYear?: unknown };
    days?: unknown;
  };
  if (!r || typeof r !== 'object') {
    return { ok: false, message: 'Parser output is not an object.' };
  }
  const title = typeof r.calendar?.title === 'string' ? r.calendar.title : '';
  const year =
    typeof r.calendar?.schoolYear === 'string' ? r.calendar.schoolYear : '';
  if (!Array.isArray(r.days)) {
    return { ok: false, message: 'Parser output missing days[].' };
  }
  const out: CalendarDay[] = [];
  for (const d of r.days as unknown[]) {
    if (!d || typeof d !== 'object') continue;
    const o = d as Record<string, unknown>;
    const date = typeof o.date === 'string' ? o.date : null;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const cycleDay = clampCycleDay(o.cycleDay);
    const holidayCode = normalizeHolidayCode(o.holidayCode);
    const isInstructional =
      typeof o.isInstructional === 'boolean'
        ? o.isInstructional
        : cycleDay !== null;
    out.push({
      date,
      month: typeof o.month === 'number' ? o.month : 0,
      day: typeof o.day === 'number' ? o.day : 0,
      weekday: typeof o.weekday === 'string' ? o.weekday : '',
      cycleDay,
      isInstructional,
      holidayCode,
      // Verifier feedback (MED-1, 2026-07-05): read note from the
      // python dict so future parser revisions carrying annotations
      // like 'exam day' / 'half day' flow through to cycle_calendar.
      note: typeof o.note === 'string' ? o.note : null,
    });
  }
  if (out.length === 0) {
    return { ok: false, message: 'Parser emitted zero valid days.' };
  }
  return { ok: true, calendarTitle: title, schoolYear: year, days: out };
}

function clampCycleDay(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10) {
    return v;
  }
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 10) return n;
  }
  return null;
}

function normalizeHolidayCode(v: unknown): HolidayCode {
  if (typeof v !== 'string') return null;
  const upper = v.toUpperCase();
  return (KNOWN_HOLIDAY_CODES as readonly string[]).includes(upper)
    ? (upper as HolidayCode)
    : null;
}

function mapPythonError(code: string): ParseFailure['code'] {
  switch (code) {
    case 'scanned_pdf':
      return 'scanned_pdf';
    case 'no_usable_calendar':
      return 'no_usable_calendar';
    case 'invalid_pdf':
      return 'invalid_pdf';
    case 'timeout':
      return 'timeout';
    case 'pdfplumber_missing':
      return 'pdfplumber_missing';
    case 'pdfplumber_crashed':
      return 'pdfplumber_crashed';
    default:
      return 'unknown';
  }
}

function pythonDefaultMessage(code: string): string {
  switch (code) {
    case 'scanned_pdf':
      return 'Re-upload a text PDF — this one is scanned.';
    case 'no_usable_calendar':
      return "Couldn't find a calendar grid — wrong format.";
    case 'invalid_pdf':
      return 'This file is not a valid PDF.';
    case 'timeout':
      return 'Parsing took too long — try a smaller PDF.';
    case 'pdfplumber_missing':
      return 'Calendar parser offline — try again later.';
    case 'pdfplumber_crashed':
      return "Couldn't read this PDF — try another file.";
    default:
      return 'Unknown parsing error.';
  }
}

function computeSummary(days: CalendarDay[]): CalendarSummary {
  const byCode: Record<string, number> = {};
  let inst = 0;
  let pa = 0;
  let mandatory = 0;
  for (const d of days) {
    const key = d.isInstructional
      ? String(d.cycleDay ?? '?')
      : (d.holidayCode ?? '?');
    byCode[key] = (byCode[key] ?? 0) + 1;
    if (d.isInstructional) inst++;
    if (d.holidayCode === 'E' || d.holidayCode === 'ES' || d.holidayCode === '0') {
      pa++;
    }
    if (d.holidayCode === 'M') mandatory++;
  }
  return {
    totalDays: days.length,
    instructionalDays: inst,
    paDays: pa,
    mandatoryHolidays: mandatory,
    byCode,
  };
}

async function cacheOutcome(out: ParseSuccess): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(cacheKey(out.jobId), JSON.stringify(out), 'EX', CACHE_TTL_SEC);
  } catch (err) {
    logger.warn(
      { err, jobId: out.jobId },
      'pdf_calendar_extract: cache write failed (non-fatal)',
    );
  }
}

export async function readCachedParse(
  jobId: string,
): Promise<ParseSuccess | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const blob = await r.get(cacheKey(jobId));
    if (!blob) return null;
    const parsed = JSON.parse(blob) as unknown;
    const v = validateShape(
      (parsed as { days?: unknown }).days ? parsed : null,
    );
    if (!v.ok) return null;
    const summary = computeSummary(v.days);
    return {
      ok: true,
      jobId,
      sha256:
        typeof (parsed as { sha256?: unknown }).sha256 === 'string'
          ? (parsed as { sha256: string }).sha256
          : '',
      calendarTitle: v.calendarTitle,
      schoolYear: v.schoolYear,
      days: v.days,
      summary,
      durationMs:
        typeof (parsed as { durationMs?: unknown }).durationMs === 'number'
          ? (parsed as { durationMs: number }).durationMs
          : 0,
    };
  } catch (err) {
    logger.warn(
      { err, jobId },
      'pdf_calendar_extract: cache read failed (non-fatal)',
    );
    return null;
  }
}

export function __setRedisForTests(client: IORedis | null): void {
  redis = client;
}
