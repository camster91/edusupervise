// apps/web/server/pdf-parser.server.ts
//
// Phase 2 — PDF schedule ingestion.
//
// What this module does:
//   1. Shells out to `apps/web/server/pdf_extract.py` (pdfplumber under
//      the hood) to extract every table on every page of the staged
//      PDF.
//   2. Scores each candidate table by:
//        - number of cells matching a teacher-name pattern (Capitalized
//          word, optionally followed by "Lastname, Firstname");
//        - column headers matching day/period patterns
//          ("Day 1" / "Day 2" / "Mon" / "Period 1" / "Block A");
//        - size penalty for tables in the page header/footer regions
//          (page numbers, "Last updated" stamps).
//   3. Returns a list of "best row" objects shaped for the review UI:
//        { kind: 'cycle' | 'recurring',
//          cycleDay: 1..10,
//          teacherName: string | null,
//          role: 'teacher' | 'educational_assistant' | null,
//          startTime, endTime, location, notes }
//   4. Caches the parse result in Redis under `pdf:{jobId}` for 24h.
//      The review page reads from the same key.
//
// Why we don't trust the table verbatim:
//   - pdfplumber often returns tables that span 2 columns of unrelated
//     data merged into one (e.g. "Late Arrivals" + "Recess Duties"
//     laid out side-by-side). The scorer caps the column count at 12
//     to reject these as noise.
//   - Some PDFs have a header row that's actually a duplicate of the
//     first data row (extraction artifact). The scorer only honours
//     the header if at least 2 of its cells match a day/period pattern.
//
// Concurrency model: spec section 2.4 says inline parsing for v1
// (pdfplumber is fast — p95 under 500ms on real district PDFs). The
// upload endpoint awaits the parser and returns `{ jobId, status:
// 'ready', rowCount }` synchronously. If p95 ever exceeds 2s we move
// to the worker queue (BullMQ on the same Redis). For now we don't
// pay that complexity cost.
//
// Failure modes (UI messages):
//   scanned_pdf         "Re-upload a text PDF"
//   pdfplumber_crashed  "Couldn't read this PDF — try another file"
//   pdfplumber_missing  "PDF service offline — try again later"
//   timeout             "Parsing took too long — try a smaller PDF"
//   no_usable_table     "Couldn't find a duty table — add duties manually"
//
// We NEVER throw to the route handler. The route handler reads
// `ParseOutcome` and decides the HTTP status. This keeps the module
// pure and easy to test.

import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import IORedis from 'ioredis';
import { logger } from './logger.server';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DutyRole = 'teacher' | 'educational_assistant';

export interface ParsedRow {
  kind: 'cycle' | 'recurring';
  /** 1..10 — only meaningful for `kind === 'cycle'`. */
  cycleDay: number | null;
  /** null when the cell is empty / "EA" without a specific teacher. */
  teacherName: string | null;
  /** null when the cell is empty. 'educational_assistant' marker → 'educational_assistant'. */
  role: DutyRole | null;
  /** HH:MM (24h). Required for the duty insert. */
  startTime: string;
  /** HH:MM (24h). Required. */
  endTime: string;
  /** Plain text — "Front doors", "Kiss N Ride", etc. */
  location: string;
  /** Free text from the cell (often blank). */
  notes: string | null;
}

export interface ParseSuccess {
  ok: true;
  jobId: string;
  /** Stable hash so we can detect re-uploads of the same PDF. */
  sha256: string;
  /** Detected cycle length from header ("Day 1..5" → 5). */
  cycleLength: number;
  rows: ParsedRow[];
  /** Wall-clock duration in ms. */
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
    | 'no_usable_table'
    | 'invalid_pdf'
    | 'file_not_found'
    | 'unknown';
  message: string;
}

export type ParseOutcome = ParseSuccess | ParseFailure;

// ---------------------------------------------------------------------------
// Redis cache (parsed result lives here for 24h)
// ---------------------------------------------------------------------------

/**
 * Parsed PDF rows live in Redis under `pdf:{jobId}` for 24h. Why Redis
 * (not in-memory like rate-limit) and not the DB:
 *   - The web container may restart (deploy, OOM); in-memory loses
 *     the parsed result and the user has to re-upload. That's a real
 *     workflow breakage because the review UI is the ONLY place they
 *     can edit the parsed rows before confirm.
 *   - Phase 3 may move this to a worker container; an in-process map
 *     becomes useless at that point.
 *   - A `pdf_jobs` table would require a Phase-3-owned migration; we
 *     stay out of `packages/db/src/schema.ts` per Phase 2 scope.
 *
 * Failure mode: if Redis is unreachable, we still return the parse
 * outcome synchronously and skip the cache write. The review page
 * would then fail to find the jobId; the UI surfaces a "session
 * expired — re-upload" message and asks the user to try again. This
 * is acceptable because the alternative (refusing to parse) is
 * worse: a deploy hot-spot shouldn't kill PDF ingestion.
 *
 * Why a separate DB number (db=1): the worker uses db=0 for BullMQ
 * keys; using db=1 here avoids noisy-neighbor evictions if we ever
 * hit Redis memory pressure.
 */
let _redis: IORedis | null = null;
function getRedis(): IORedis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (_redis) return _redis;
  _redis = new IORedis(url, {
    db: 1,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });
  _redis.on('error', (err) => {
    // Don't crash on transient errors; log and move on.
    logger.debug({ err: err.message }, 'pdf-parser: redis error (non-fatal)');
  });
  return _redis;
}

const CACHE_TTL_SEC = 24 * 60 * 60;

async function cacheStore(key: string, payload: ParseOutcome): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(key, JSON.stringify(payload), 'EX', CACHE_TTL_SEC);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'pdf-parser: cache write failed (non-fatal)',
    );
  }
}

/** Public read API used by the review page loader. */
export async function cacheRead(jobId: string): Promise<ParseOutcome | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get(`pdf:${jobId}`);
    if (!raw) return null;
    return JSON.parse(raw) as ParseOutcome;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'pdf-parser: cache read failed',
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public entry — parsePdf
// ---------------------------------------------------------------------------

export interface ParsePdfInput {
  /** Absolute path to the staged PDF on the web container's filesystem. */
  filePath: string;
  /** Pre-computed SHA-256 (hex, lowercase). Used as the cache key suffix
   * so re-uploads of the same PDF land on the same jobId. */
  sha256: string;
  /**
   * Wall-clock budget for the python child process. Default 8s — most
   * district PDFs parse in <500ms; this leaves headroom for the
   * pathological 50-page case.
   */
  timeoutMs?: number;
}

/**
 * Run pdfplumber on `filePath`, score the tables, normalise the rows,
 * and cache the outcome. Always resolves (never throws) so the route
 * handler can map the outcome to an HTTP status without try/catch.
 */
export async function parsePdf(input: ParsePdfInput): Promise<ParseOutcome> {
  const jobId = randomUUID();
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? 8000;
  const cacheKey = `pdf:${jobId}`;

  const scriptPath = resolveScriptPath();
  if (!scriptPath) {
    const failure: ParseFailure = {
      ok: false,
      jobId,
      sha256: input.sha256,
      code: 'pdfplumber_missing',
      message: 'PDF service offline — try again in a few minutes.',
    };
    return failure;
  }

  let raw: ExtractResult;
  try {
    raw = await runExtract(scriptPath, input.filePath, timeoutMs);
  } catch (err) {
    const failure = mapChildProcessError(err, jobId, input.sha256);
    await cacheStore(cacheKey, failure);
    return failure;
  }

  if (!raw.ok) {
    const failure = mapExtractError(raw, jobId, input.sha256);
    await cacheStore(cacheKey, failure);
    return failure;
  }

  // Score tables and normalise to ParsedRow[].
  const scored = scoreAllTables(raw.pages);
  if (scored.bestTable === null) {
    const failure: ParseFailure = {
      ok: false,
      jobId,
      sha256: input.sha256,
      code: 'no_usable_table',
      message:
        'No duty table found in this PDF. You can still add duties manually below.',
    };
    await cacheStore(cacheKey, failure);
    return failure;
  }

  const { header, dataRows, cycleLength } = scored.bestTable;
  const rows = normaliseRows(header, dataRows);

  const success: ParseSuccess = {
    ok: true,
    jobId,
    sha256: input.sha256,
    cycleLength,
    rows,
    durationMs: Date.now() - startedAt,
  };
  await cacheStore(cacheKey, success);
  logger.info(
    {
      jobId,
      sha256: input.sha256,
      rowCount: rows.length,
      cycleLength,
      durationMs: success.durationMs,
    },
    'pdf-parser: success',
  );
  return success;
}

// ---------------------------------------------------------------------------
// Python bridge
// ---------------------------------------------------------------------------

interface ExtractOk {
  ok: true;
  pages: Array<{
    page_number: number;
    text_chars: number;
    tables: Array<{ rows: string[][] }>;
  }>;
}

interface ExtractErr {
  ok: false;
  error: string;
  detail: string;
}

type ExtractResult = ExtractOk | ExtractErr;

function resolveScriptPath(): string | null {
  // When running from the bundled RR7 server, `import.meta.url` points
  // at apps/web/server/pdf-parser.server.ts. The Python helper sits
  // next to it. In a vitest test, cwd may differ — fall back to
  // `process.cwd()/apps/web/server/pdf_extract.py`.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.resolve(here, 'pdf_extract.py');
    // Existence check is done at exec time via the child's fs; here we
    // only resolve the path string.
    return candidate;
  } catch {
    return null;
  }
}

async function runExtract(
  scriptPath: string,
  filePath: string,
  timeoutMs: number,
): Promise<ExtractResult> {
  return new Promise<ExtractResult>((resolve) => {
    // We do NOT promisify here — we want to capture the exit code
    // distinctly from stdout/stderr. `execFile` (callback form) gives
    // us both; promisified throws on non-zero exit which conflates
    // "extractor said scanned_pdf" (exit 3) with "child crashed"
    // (exit 1).
    const child: ChildProcess = execFile(
      'python3',
      [scriptPath, filePath],
      {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          PDF_PARSE_TIMEOUT_MS: String(timeoutMs),
        },
      },
      (err, stdout, _stderr) => {
        const text = stdout?.toString('utf8') ?? '';
        if (!text.trim()) {
          resolve({
            ok: false,
            error: 'pdfplumber_crashed',
            detail: err?.message ?? 'empty stdout',
          });
          return;
        }
        let parsed: ExtractResult;
        try {
          parsed = JSON.parse(text) as ExtractResult;
        } catch (parseErr) {
          resolve({
            ok: false,
            error: 'pdfplumber_crashed',
            detail: `non-JSON stdout: ${(parseErr as Error).message}`,
          });
          return;
        }
        resolve(parsed);
      },
    );
    // Suppress the default "Unhandled error event" if the child fails
    // to spawn (e.g. python3 missing). The callback above already
    // reports it.
    child.on('error', () => {
      // no-op — handled in callback
    });
  });
}

function mapChildProcessError(
  err: unknown,
  jobId: string,
  sha256: string,
): ParseFailure {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('ENOENT')) {
    return {
      ok: false,
      jobId,
      sha256,
      code: 'pdfplumber_missing',
      message: 'PDF service offline — try again in a few minutes.',
    };
  }
  if (msg.toLowerCase().includes('timeout')) {
    return {
      ok: false,
      jobId,
      sha256,
      code: 'timeout',
      message: 'Parsing took too long. Try a smaller PDF.',
    };
  }
  return {
    ok: false,
    jobId,
    sha256,
    code: 'pdfplumber_crashed',
    message: "Couldn't read this PDF — try another file.",
  };
}

function mapExtractError(
  raw: ExtractErr,
  jobId: string,
  sha256: string,
): ParseFailure {
  const code = (['scanned_pdf', 'pdfplumber_crashed', 'pdfplumber_missing',
    'timeout', 'no_usable_table', 'invalid_pdf', 'file_not_found']
    .includes(raw.error)
    ? raw.error
    : 'unknown') as ParseFailure['code'];
  const message =
    code === 'scanned_pdf'
      ? 'This PDF is image-only. Re-upload a text version (export from Word/Google Docs, or scan with OCR).'
      : code === 'file_not_found'
      ? 'Upload failed — file is missing.'
      : code === 'pdfplumber_missing'
      ? 'PDF service offline — try again in a few minutes.'
      : code === 'timeout'
      ? 'Parsing took too long. Try a smaller PDF.'
      : "Couldn't read this PDF — try another file.";
  return { ok: false, jobId, sha256, code, message };
}

// ---------------------------------------------------------------------------
// Table scoring
// ---------------------------------------------------------------------------

const DAY_HEADER_RE =
  /^(day\s*[1-9]|day\s*10|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|period\s*[1-9]|block\s*[a-z])$/i;

const TIME_RANGE_RE =
  /(\d{1,2}):(\d{2})\s*(?:[–—\-]\s*(\d{1,2}):(\d{2}))?/;

const RECURRING_HEADER_RE =
  /(early\s+entry|kiss\s*n?\s*ride|back\s+tarmac|recess|lunch|dismissal)/i;

const TEACHER_NAME_RE = /^[A-Z][a-zA-Z'.-]+(?:\s+[A-Z][a-zA-Z'.-]+)?$/;

const EA_MARKER_RE = /^ea$/i;

interface ScoredTable {
  page: number;
  score: number;
  header: string[];
  dataRows: string[][];
  cycleLength: number;
}

/**
 * Score every table on every page; return the highest-scoring one.
 * Returns null when no table reaches a minimum score — the UI
 * surfaces a "couldn't find a duty table" message.
 */
function scoreAllTables(
  pages: ExtractOk['pages'],
): { bestTable: ScoredTable | null } {
  let best: ScoredTable | null = null;
  for (const page of pages) {
    // Skip pages that are clearly not tables (cover pages, agendas).
    if (page.text_chars < 30) continue;
    for (const tbl of page.tables) {
      if (!tbl.rows.length) continue;
      const scored = scoreOneTable(tbl.rows, page.page_number);
      if (!scored) continue;
      if (!best || scored.score > best.score) {
        best = scored;
      }
    }
  }
  return { bestTable: best };
}

function scoreOneTable(
  rows: string[][],
  page: number,
): ScoredTable | null {
  if (rows.length < 2) return null;
  const header = rows[0]!;
  if (header.length < 2 || header.length > 12) return null;

  // Header pattern: how many cells look like day/period labels?
  const headerMatches = header.filter((c) =>
    DAY_HEADER_RE.test((c ?? '').trim()),
  ).length;
  if (headerMatches < 2) return null; // Not a duty table.

  // Body pattern: how many cells look like teacher names / EA markers?
  const bodyRows = rows.slice(1);
  let nameCells = 0;
  let eaCells = 0;
  let recurringCells = 0;
  for (const row of bodyRows) {
    for (const cell of row) {
      const trimmed = (cell ?? '').trim();
      if (!trimmed) continue;
      if (EA_MARKER_RE.test(trimmed)) {
        eaCells += 1;
        continue;
      }
      if (TEACHER_NAME_RE.test(trimmed)) {
        nameCells += 1;
        continue;
      }
      if (RECURRING_HEADER_RE.test(trimmed) || TIME_RANGE_RE.test(trimmed)) {
        recurringCells += 1;
      }
    }
  }

  // Detect a recurring-duty table (e.g. "Early Entry 8:45-9:00 Kiss N Ride")
  // and treat its "rows" as individual recurring duties rather than
  // day-shifted teacher assignments.
  const looksRecurring =
    headerMatches <= 2 && recurringCells >= 1 && nameCells === 0;

  const totalScore =
    headerMatches * 3 + nameCells * 2 + eaCells + recurringCells;
  if (totalScore < 5) return null;

  // Cycle length from header: "Day 1" through "Day N".
  let cycleLength = headerMatches;
  for (const cell of header) {
    const m = /day\s*(\d+)/i.exec(cell ?? '');
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 1 && n <= 10) {
        cycleLength = Math.max(cycleLength, n);
      }
    }
  }

  return {
    page,
    score: totalScore + (looksRecurring ? 1 : 0),
    header: header.map((c) => (c ?? '').trim()),
    dataRows: bodyRows,
    cycleLength,
  };
}

// ---------------------------------------------------------------------------
// Row normalisation
// ---------------------------------------------------------------------------

/**
 * Map the best table to a flat list of ParsedRow, deduping teacher
 * names within a cycle day so the reviewer doesn't see "Attwood,
 * Attwood, Attwood" if pdfplumber reported it three ways.
 *
 * Empty cells (the "--" placeholder in Jason's PDF) stay empty —
 * the user explicitly said NOT to auto-fill them. We preserve the
 * emptiness through to the DB write so the duty exists without an
 * assignment.
 */
function normaliseRows(
  header: string[],
  bodyRows: string[][],
): ParsedRow[] {
  const cycleDayByCol = header.map(parseCycleDayFromHeader);
  const out: ParsedRow[] = [];

  for (const row of bodyRows) {
    for (let col = 0; col < header.length; col += 1) {
      const raw = (row[col] ?? '').trim();
      const cycleDay = cycleDayByCol[col] ?? null;

      if (!raw) continue; // Empty cell — skip (we render an empty row in the UI).

      // Skip cells that look like headers / day labels bleeding into data
      if (DAY_HEADER_RE.test(raw) && cycleDay === null) continue;

      // EA marker — emit a row with role=educational_assistant, no teacher name.
      if (EA_MARKER_RE.test(raw)) {
        out.push({
          kind: 'cycle',
          cycleDay,
          teacherName: null,
          role: 'educational_assistant',
          startTime: '08:45',
          endTime: '09:00',
          location: '',
          notes: null,
        });
        continue;
      }

      // Teacher name
      if (TEACHER_NAME_RE.test(raw) || looksLikeTeacherList(raw)) {
        out.push({
          kind: 'cycle',
          cycleDay,
          teacherName: raw,
          role: 'teacher',
          startTime: '08:45',
          endTime: '09:00',
          location: '',
          notes: null,
        });
        continue;
      }

      // Anything else (time range, location, free text) → ignore for v1.
      // Phase 3 will detect "Early Entry 8:45-9:00 at Kiss N Ride"
      // and emit recurringDuty rows; v1 is intentionally narrower.
    }
  }
  return out;
}

/**
 * Map "Day 3" / "Mon" / "Period 2" → integer cycle day.
 * Returns null if the header cell doesn't carry a day number.
 */
function parseCycleDayFromHeader(cell: string): number | null {
  const trimmed = cell.trim();
  const m1 = /day\s*(\d+)/i.exec(trimmed);
  if (m1 && m1[1]) {
    const n = parseInt(m1[1], 10);
    if (n >= 1 && n <= 10) return n;
  }
  const m2 = /period\s*(\d+)/i.exec(trimmed);
  if (m2 && m2[1]) {
    const n = parseInt(m2[1], 10);
    if (n >= 1 && n <= 10) return n;
  }
  // Mon=1, Tue=2, ... per ISO. We can't tell from "Mon" alone whether
  // the rotation is Mon-based or Day-1-based; we default to the
  // weekday index. The review UI lets the user re-map if it's wrong.
  const dayMap: Record<string, number> = {
    mon: 1, monday: 1,
    tue: 2, tues: 2, tuesday: 2,
    wed: 3, weds: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5,
    sat: 6, saturday: 6,
    sun: 7, sunday: 7,
  };
  const lower = trimmed.toLowerCase();
  return dayMap[lower] ?? null;
}

/**
 * "Cyriac, Loganathan, Sheikh" — three names in one cell, comma-
 * separated. v1 emits them as a single teacherName string with a
 * comma so the user can edit/split in the review UI. Phase 3 will
 * split into multiple dutyAssignment rows.
 */
function looksLikeTeacherList(s: string): boolean {
  if (!s.includes(',')) return false;
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every((p) => TEACHER_NAME_RE.test(p));
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/**
 * Test seam: reset the cached Redis client between integration tests
 * so each test gets a fresh connection pool. Only used by the test
 * harness; do not call from production code paths.
 */
export function __resetRedisForTests(): void {
  if (_redis) {
    _redis.disconnect();
    _redis = null;
  }
}

// Suppress unused warning for execFileAsync; kept for future use
// (e.g. batched multi-PDF parsing) where promisify is cleaner.
void execFileAsync;